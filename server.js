const express = require('express');
const OpenTimestamps = require('opentimestamps');
const app = express();

app.use(express.json({ limit: '10mb' }));

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

app.post('/upgrade', async (req, res) => {
  try {
    const { ots } = req.body;
    if (!ots) return res.status(400).json({ error: 'Falta ots' });

    const otsBytes = Buffer.from(ots, 'base64');
    const detached = OpenTimestamps.DetachedTimestampFile.deserialize(otsBytes);
    
    // Intentar upgrade
    await OpenTimestamps.upgrade(detached);
    
    // Serializar el .ots actualizado
    const otsActualizado = Buffer.from(detached.serializeToBytes()).toString('base64');
    
    // Verificar si hay attestation de Bitcoin
    const timestamp = detached.timestamp;
    let confirmado = false;
    let bloque = 0;
    let timestampUtc = '';

    function buscarAttestation(ts) {
      for (const [op, subTs] of ts.ops) {
        if (subTs.attestations) {
          for (const att of subTs.attestations) {
            if (att.type === 'BitcoinBlockHeaderAttestation') {
              confirmado = true;
              bloque = att.height;
              return;
            }
          }
        }
        buscarAttestation(subTs);
      }
    }
    buscarAttestation(timestamp);

    res.json({ confirmado, bloque, timestampUtc, otsActualizado });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('OTSify server running on port', PORT));