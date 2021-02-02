const express = require('express');
const morgan = require('morgan');
const cors = require('cors');

const nodeEnv = process.env.NODE_ENV;

const app = express();

if (nodeEnv !== 'test') {
  app.use(morgan('combined'));
}

app.use(cors());
require('../routes')(app);

module.exports = app;
