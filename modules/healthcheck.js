const express = require('express');
const http = require('http');

const app = express();
const router = express.Router();

router.use((req, res, next) => {
  res.header('Access-Control-Allow-Methods', 'GET');
  next();
});

// @TODO We should add more logic here to reflect actual bot health
router.get('/health', (req, res) => {
  res.status(200).send('stonks');
});

app.use('/api/v1', router);

const server = http.createServer(app);
server.listen(11312);
