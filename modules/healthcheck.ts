const http = require("node:http");
const express = require("express");

const app = express();
const router = express.Router();

router.use((_request, response, next) => {
  response.header("Access-Control-Allow-Methods", "GET");
  next();
});

// @TODO We should add more logic here to reflect actual bot health
router.get("/health", (_request, response) => {
  response.status(200).send("stonks");
});

app.use("/api/v1", router);

const server = http.createServer(app);
server.listen("11312");
