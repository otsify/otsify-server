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

    // Decodificar base64 a bytes
    const otsBytes = Buffer.from(ots, 'base64');
    
    // Deserializar el .ots
    const detached = OpenTimestamps.DetachedTimestampFile.deserialize(otsBytes);
    
    // Intentar upgrade (consulta al calendario)
    await OpenTimestamps.upgrade(detached);
    
    // Verificar si hay attestation de Bitcoin
    const context = new OpenTimestamps.VerifyContext();
    const results = await OpenTimestamps.verify(detached, context);
    
    // Serializar el .ots actualizado
    const otsActualizado = Buffer.from(detached.serializeToBytes()).toString('base64');
    
    if (results && Object.keys(results).length > 0) {
      const timestamp = Object.values(results)[0];
      const bloque = timestamp.height || 0;
      const timestampUtc = new Date(timestamp.timestamp * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
      res.json({ 
        confirmado: true, 
        bloque, 
        timestampUtc,
        otsActualizado 
      });
    } else {
      res.json({ 
        confirmado: false,
        otsActualizado 
      });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('OTSify server running on port', PORT));