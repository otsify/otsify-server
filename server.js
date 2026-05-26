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
    
    await OpenTimestamps.upgrade(detached);
    
    const otsActualizado = Buffer.from(detached.serializeToBytes()).toString('base64');
    
    // Buscar Bitcoin attestation recursivamente
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

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('OTSify server running on port', PORT));