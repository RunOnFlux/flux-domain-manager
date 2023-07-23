const express = require('express');
const morgan = require('morgan');
const cors = require('cors');
const path = require('path');

const nodeEnv = process.env.NODE_ENV;

const app = express();

if (nodeEnv !== 'test') {
  app.use(morgan('combined'));
}

app.set('views', path.join(__dirname, '../views'));
app.set('view engine', 'pug');

app.use(cors());
require('../routes')(app);

module.exports = app;
