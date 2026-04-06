import log from 'electron-log/main';

log.transports.file.level = 'info';
log.transports.console.level = 'debug';
log.transports.file.fileName = 'discdeck.log';

export const logger = log.scope('discdeck');
export default logger;
