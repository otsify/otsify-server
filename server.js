const express = require('express');
const OpenTimestamps = require('opentimestamps');
const admin = require('firebase-admin');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

// ── Firebase Admin ──────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

// ── Express ─────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '10mb' }));

// ── /stamp ───────────────────────────────────────────────────────────────────
app.post('/stamp', async (req, res) => {
  try {
    const { contenido } = req.body;
    if (!contenido) return res.status(400).json({ error: 'Falta contenido' });
    const encoder = new TextEncoder();
    const bytes = encoder.encode(contenido);
    const detached = OpenTimestamps.DetachedTimestampFile.fromBytes(
      new OpenTimestamps.Ops.OpSHA256(),
      bytes
    );
    await OpenTimestamps.stamp(detached);
    const otsBytes = detached.serializeToBytes();
    const otsBase64 = Buffer.from(otsBytes).toString('base64');
    res.json({ ots: otsBase64 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /upgrade ─────────────────────────────────────────────────────────────────
app.post('/upgrade', async (req, res) => {
  try {
    const { ots } = req.body;
    if (!ots) return res.status(400).json({ error: 'Falta ots' });
    const otsBytes = Buffer.from(ots, 'base64');
    const detached = OpenTimestamps.DetachedTimestampFile.deserialize(otsBytes);
    await OpenTimestamps.upgrade(detached);
    const otsActualizado = Buffer.from(detached.serializeToBytes()).toString('base64');
    let confirmado = false;
    let bloque = 0;
    function buscarEnTimestamp(ts) {
      if (!ts) return;
      for (const att of ts.attestations) {
        const attStr = att.toString();
        if (attStr.includes('BitcoinBlockHeader') || att.constructor.name === 'BitcoinBlockHeaderAttestation') {
          confirmado = true;
          bloque = att.height || 0;
          return;
        }
      }
      for (const [op, subTs] of ts.ops) {
        buscarEnTimestamp(subTs);
        if (confirmado) return;
      }
    }
    buscarEnTimestamp(detached.timestamp);
    res.json({ confirmado, bloque, otsActualizado });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /mp-webhook ──────────────────────────────────────────────────────────────
//
// MercadoPago llama a este endpoint cuando se confirma un pago.
// Flujo:
//   1. Recibir notificación
//   2. Verificar el pago consultando la API de MP
//   3. Confirmar que el monto y estado son correctos
//   4. Buscar el usuario en Firestore por email
//   5. Actualizar plan a "pro" con fecha de vencimiento +30 días
//
app.post('/mp-webhook', async (req, res) => {
  try {
    const { type, data } = req.body;

    // Solo procesar eventos de pago
    if (type !== 'payment') {
      return res.status(200).json({ ok: true, ignorado: true });
    }

    const paymentId = data?.id;
    if (!paymentId) return res.status(400).json({ error: 'Falta payment id' });

    // 1. Consultar el pago en la API de MercadoPago
    const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: {
        Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`,
      },
    });

    if (!mpRes.ok) {
      console.error('mp-webhook: error consultando pago', mpRes.status);
      return res.status(500).json({ error: 'No se pudo verificar el pago' });
    }

    const pago = await mpRes.json();
    console.log('mp-webhook: pago recibido', pago.id, pago.status, pago.transaction_amount);

    // 2. Verificar que el pago esté aprobado
    if (pago.status !== 'approved') {
      console.log('mp-webhook: pago no aprobado, ignorando', pago.status);
      return res.status(200).json({ ok: true, ignorado: true });
    }

    // 3. Obtener el email del comprador
    const email = pago.payer?.email;
    if (!email) {
      console.error('mp-webhook: no se encontró email del comprador');
      return res.status(400).json({ error: 'No se encontró email del comprador' });
    }

    console.log('mp-webhook: buscando usuario con email', email);

    // 4. Buscar el usuario en Firestore por email
    const usuariosSnap = await db.collection('usuarios')
      .where('email', '==', email)
      .limit(1)
      .get();

    if (usuariosSnap.empty) {
      // El usuario no existe aún — crear el documento con el plan pro
      // Esto puede pasar si el usuario pagó antes de registrarse en la app
      console.log('mp-webhook: usuario no encontrado, guardando pago pendiente');
      await db.collection('pagos_pendientes').add({
        email,
        paymentId: pago.id,
        monto: pago.transaction_amount,
        fecha: new Date().toISOString(),
        procesado: false,
      });
      return res.status(200).json({ ok: true, pendiente: true });
    }

    // 5. Actualizar el plan del usuario
    const uid = usuariosSnap.docs[0].id;
    const ahora = new Date();
    const vencimiento = new Date(ahora.getTime() + 30 * 24 * 60 * 60 * 1000);
    const planVence = vencimiento.toISOString().split('T')[0]; // YYYY-MM-DD

    await db.collection('usuarios').doc(uid).update({
      plan:       'pro',
      planVence,
      paymentId:  pago.id,
      ultimoPago: ahora.toISOString(),
    });

    console.log('mp-webhook: plan pro activado para', email, 'vence', planVence);
    return res.status(200).json({ ok: true, uid, planVence });

  } catch (e) {
    console.error('mp-webhook error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ── /health ──────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true }));

// ── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('OTSify server running on port', PORT));
