// Centralized electron-log wrapper. Writes to discdeck.log under the
// Electron userData path; use logger.scope(name) to tag per-module output.
import log from 'electron-log';

log.transports.file.level = 'info';
log.transports.console.level = 'debug';
log.transports.file.fileName = 'discdeck.log';

export const logger = log.scope('discdeck');
export default logger;
