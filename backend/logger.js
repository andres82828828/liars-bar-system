// =====================================================================
//  Technical error log (RNF-23) with winston
//  Errors go to backend/logs/error.log (one JSON line each) and to the console.
//  Never log passwords, hashes or session tokens here.
// =====================================================================
const path = require('path');
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.errors({ stack: true }), winston.format.json()),
  transports: [
    new winston.transports.File({ filename: path.join(__dirname, 'logs', 'error.log'), level: 'error', maxsize: 5 * 1024 * 1024, maxFiles: 5 }),
    new winston.transports.Console({ format: winston.format.simple(), level: 'error' })
  ]
});

module.exports = { logger };
