'use strict';
const { createLogger, transports, format } = require('winston');

const logger = createLogger({
    level: process.env.LOG_LEVEL || '=debug',
    format: format.combine(
        format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        format.errors({ stack: true }),
        format.printf(({ timestamp, level, message, stack }) =>
            stack
                ? `${timestamp} [${level.toUpperCase()}] ${message}\n${stack}`
                : `${timestamp} [${level.toUpperCase()}] ${message}`
        )
    ),
    transports: [new transports.Console()],
});

module.exports = logger;
