const express = require('express');
const buildRoutes = require('./buildRoutes');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'coderit-build-backend' });
});

app.use(buildRoutes);

app.listen(PORT, () => {
  console.log(`CoderIT build backend listening on port ${PORT}`);
});
