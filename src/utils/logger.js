const fs = require('fs');
const path = require('path');
const util = require('util');

/**
 * Professional Logger Utility
 * Enterprise-grade logging with multiple transports,
 * structured logging, and performance optimization
 */
class Logger {
    constructor(options = {}) {
        this.config = this._mergeConfig(options);
        this.transports = new Map();
        this.logQueue = [];
        this.isProcessing = false;
        this.rotationTimer = null;
        
        // Initialize transports
        this._initializeTransports();
        
        // Setup log rotation if file logging is enabled
        if (this.config.file.enabled) {
            this._setupLogRotation();
        }
        
        // Setup graceful shutdown
        this._setupShutdownHandler();
    }

    /**
     * Merge user configuration with defaults
     * @private
     * @param {Object} options - User configuration
     * @returns {Object} Merged configuration
     */
    _mergeConfig(options) {
        const defaultConfig = {
            level: process.env.LOG_LEVEL || 'info',
            format: 'json', // 'json' or 'text'
            
            // Console transport
            console: {
                enabled: true,
                colors: true,
                timestamp: true
            },
            
            // File transport
            file: {
                enabled: process.env.NODE_ENV === 'production',
                directory: './logs',
                filename: 'photon-server.log',
                maxSize: 50 * 1024 * 1024, // 50MB
                maxFiles: 10,
                compress: true
            },
            
            // Error file transport
            errorFile: {
                enabled: process.env.NODE_ENV === 'production',
                directory: './logs',
                filename: 'photon-error.log',
                maxSize: 10 * 1024 * 1024, // 10MB
                maxFiles: 5
            },
            
            // Performance options
            async: true,
            bufferSize: 1000,
            flushInterval: 5000,
            
            // Context options
            includeMetadata: true,
            maxContextDepth: 3,
            maxStringLength: 1000
        };

        return this._deepMerge(defaultConfig, options);
    }

    /**
     * Deep merge two objects
     * @private
     * @param {Object} target - Target object
     * @param {Object} source - Source object
     * @returns {Object} Merged object
     */
    _deepMerge(target, source) {
        const result = { ...target };
        
        for (const key in source) {
            if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
                result[key] = this._deepMerge(target[key] || {}, source[key]);
            } else {
                result[key] = source[key];
            }
        }
        
        return result;
    }

    /**
     * Initialize logging transports
     * @private
     */
    _initializeTransports() {
        // Console transport
        if (this.config.console.enabled) {
            this.transports.set('console', new ConsoleTransport(this.config.console));
        }
        
        // File transport
        if (this.config.file.enabled) {
            this.transports.set('file', new FileTransport(this.config.file));
        }
        
        // Error file transport
        if (this.config.errorFile.enabled) {
            this.transports.set('errorFile', new FileTransport({
                ...this.config.errorFile,
                level: 'error'
            }));
        }
    }

    /**
     * Setup log rotation
     * @private
     */
    _setupLogRotation() {
        this.rotationTimer = setInterval(() => {
            this._rotateLogsIfNeeded();
        }, 60000); // Check every minute
    }

    /**
     * Setup graceful shutdown handler
     * @private
     */
    _setupShutdownHandler() {
        const shutdown = async () => {
            await this.flush();
            if (this.rotationTimer) {
                clearInterval(this.rotationTimer);
            }
        };

        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
        process.on('exit', shutdown);
    }

    /**
     * Get log levels with numeric values
     * @private
     * @returns {Object} Log levels
     */
    _getLogLevels() {
        return {
            fatal: 0,
            error: 1,
            warn: 2,
            info: 3,
            debug: 4,
            trace: 5
        };
    }

    /**
     * Check if level should be logged
     * @private
     * @param {string} level - Log level to check
     * @returns {boolean} Should log
     */
    _shouldLog(level) {
        const levels = this._getLogLevels();
        const currentLevel = levels[this.config.level] || levels.info;
        const messageLevel = levels[level] || levels.info;
        
        return messageLevel <= currentLevel;
    }

    /**
     * Create log entry
     * @private
     * @param {string} level - Log level
     * @param {string} message - Log message
     * @param {Object} context - Additional context
     * @returns {Object} Log entry
     */
    _createLogEntry(level, message, context = {}) {
        const timestamp = new Date().toISOString();
        const metadata = this.config.includeMetadata ? this._getMetadata() : {};
        
        const entry = {
            timestamp,
            level: level.toUpperCase(),
            message: this._sanitizeMessage(message),
            ...metadata,
            ...this._sanitizeContext(context)
        };

        return entry;
    }

    /**
     * Get runtime metadata
     * @private
     * @returns {Object} Metadata
     */
    _getMetadata() {
        const memUsage = process.memoryUsage();
        
        return {
            pid: process.pid,
            hostname: require('os').hostname(),
            memory: {
                heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
                heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + 'MB'
            }
        };
    }

    /**
     * Sanitize log message
     * @private
     * @param {*} message - Message to sanitize
     * @returns {string} Sanitized message
     */
    _sanitizeMessage(message) {
        if (typeof message === 'string') {
            return message.length > this.config.maxStringLength 
                ? message.substring(0, this.config.maxStringLength) + '...'
                : message;
        }
        
        if (message instanceof Error) {
            return message.message;
        }
        
        return util.inspect(message, { depth: 2, maxStringLength: this.config.maxStringLength });
    }

    /**
     * Sanitize context object
     * @private
     * @param {Object} context - Context to sanitize
     * @returns {Object} Sanitized context
     */
    _sanitizeContext(context) {
        if (!context || typeof context !== 'object') {
            return {};
        }

        return this._deepSanitize(context, 0);
    }

    /**
     * Deep sanitize object
     * @private
     * @param {*} obj - Object to sanitize
     * @param {number} depth - Current depth
     * @returns {*} Sanitized object
     */
    _deepSanitize(obj, depth) {
        if (depth >= this.config.maxContextDepth) {
            return '[Max Depth Reached]';
        }

        if (obj === null || obj === undefined) {
            return obj;
        }

        if (typeof obj === 'string') {
            return obj.length > this.config.maxStringLength 
                ? obj.substring(0, this.config.maxStringLength) + '...'
                : obj;
        }

        if (typeof obj === 'function') {
            return '[Function]';
        }

        if (obj instanceof Error) {
            return {
                name: obj.name,
                message: obj.message,
                stack: obj.stack
            };
        }

        if (obj instanceof Date) {
            return obj.toISOString();
        }

        if (Array.isArray(obj)) {
            return obj.slice(0, 100).map(item => this._deepSanitize(item, depth + 1));
        }

        if (typeof obj === 'object') {
            const sanitized = {};
            let count = 0;
            
            for (const [key, value] of Object.entries(obj)) {
                if (count >= 50) { // Limit object properties
                    sanitized['...'] = `${Object.keys(obj).length - count} more properties`;
                    break;
                }
                
                sanitized[key] = this._deepSanitize(value, depth + 1);
                count++;
            }
            
            return sanitized;
        }

        return obj;
    }

    /**
     * Write log entry
     * @private
     * @param {string} level - Log level
     * @param {string} message - Log message
     * @param {Object} context - Additional context
     */
    _writeLog(level, message, context = {}) {
        if (!this._shouldLog(level)) {
            return;
        }

        const entry = this._createLogEntry(level, message, context);
        
        if (this.config.async) {
            this._queueLog(entry);
        } else {
            this._processLogEntry(entry);
        }
    }

    /**
     * Queue log entry for async processing
     * @private
     * @param {Object} entry - Log entry
     */
    _queueLog(entry) {
        this.logQueue.push(entry);
        
        if (this.logQueue.length >= this.config.bufferSize) {
            this._flushQueue();
        }
        
        if (!this.isProcessing) {
            this._scheduleFlush();
        }
    }

    /**
     * Schedule queue flush
     * @private
     */
    _scheduleFlush() {
        setTimeout(() => {
            this._flushQueue();
        }, this.config.flushInterval);
    }

    /**
     * Flush log queue
     * @private
     */
    _flushQueue() {
        if (this.logQueue.length === 0 || this.isProcessing) {
            return;
        }

        this.isProcessing = true;
        const entries = this.logQueue.splice(0);
        
        Promise.all(entries.map(entry => this._processLogEntry(entry)))
            .catch(error => {
                console.error('Error processing log queue:', error);
            })
            .finally(() => {
                this.isProcessing = false;
                
                if (this.logQueue.length > 0) {
                    this._scheduleFlush();
                }
            });
    }

    /**
     * Process individual log entry
     * @private
     * @param {Object} entry - Log entry
     * @returns {Promise<void>}
     */
    async _processLogEntry(entry) {
        const promises = [];
        
        for (const [name, transport] of this.transports) {
            try {
                if (transport.shouldHandle(entry.level.toLowerCase())) {
                    promises.push(transport.write(entry));
                }
            } catch (error) {
                console.error(`Error in transport ${name}:`, error);
            }
        }
        
        await Promise.allSettled(promises);
    }

    /**
     * Rotate logs if needed
     * @private
     */
    _rotateLogsIfNeeded() {
        for (const transport of this.transports.values()) {
            if (transport.rotateIfNeeded) {
                transport.rotateIfNeeded();
            }
        }
    }

    // Public API

    /**
     * Log fatal message
     * @param {string} message - Log message
     * @param {Object} [context={}] - Additional context
     */
    fatal(message, context = {}) {
        this._writeLog('fatal', message, context);
    }

    /**
     * Log error message
     * @param {string} message - Log message
     * @param {Object} [context={}] - Additional context
     */
    error(message, context = {}) {
        this._writeLog('error', message, context);
    }

    /**
     * Log warning message
     * @param {string} message - Log message
     * @param {Object} [context={}] - Additional context
     */
    warn(message, context = {}) {
        this._writeLog('warn', message, context);
    }

    /**
     * Log info message
     * @param {string} message - Log message
     * @param {Object} [context={}] - Additional context
     */
    info(message, context = {}) {
        this._writeLog('info', message, context);
    }

    /**
     * Log debug message
     * @param {string} message - Log message
     * @param {Object} [context={}] - Additional context
     */
    debug(message, context = {}) {
        this._writeLog('debug', message, context);
    }

    /**
     * Log trace message
     * @param {string} message - Log message
     * @param {Object} [context={}] - Additional context
     */
    trace(message, context = {}) {
        this._writeLog('trace', message, context);
    }

    /**
     * Check if debug logging is enabled
     * @returns {boolean} Debug enabled
     */
    isDebugEnabled() {
        return this._shouldLog('debug');
    }

    /**
     * Check if trace logging is enabled
     * @returns {boolean} Trace enabled
     */
    isTraceEnabled() {
        return this._shouldLog('trace');
    }

    /**
     * Create child logger with additional context
     * @param {Object} context - Additional context for all logs
     * @returns {Object} Child logger
     */
    child(context) {
        return new ChildLogger(this, context);
    }

    /**
     * Flush all pending logs
     * @returns {Promise<void>}
     */
    async flush() {
        return new Promise((resolve) => {
            if (this.logQueue.length === 0) {
                resolve();
                return;
            }

            const checkQueue = () => {
                if (this.logQueue.length === 0 && !this.isProcessing) {
                    resolve();
                } else {
                    setTimeout(checkQueue, 100);
                }
            };

            this._flushQueue();
            checkQueue();
        });
    }

    /**
     * Change log level at runtime
     * @param {string} level - New log level
     */
    setLevel(level) {
        const levels = this._getLogLevels();
        if (!levels.hasOwnProperty(level)) {
            throw new Error(`Invalid log level: ${level}`);
        }
        
        this.config.level = level;
        this.info('Log level changed', { newLevel: level });
    }

    /**
     * Get current configuration
     * @returns {Object} Current configuration
     */
    getConfig() {
        return { ...this.config };
    }

    /**
     * Get transport statistics
     * @returns {Object} Transport statistics
     */
    getStats() {
        const stats = {
            queueSize: this.logQueue.length,
            isProcessing: this.isProcessing,
            transports: {}
        };

        for (const [name, transport] of this.transports) {
            stats.transports[name] = transport.getStats ? transport.getStats() : {};
        }

        return stats;
    }
}

/**
 * Child Logger for contextual logging
 */
class ChildLogger {
    constructor(parent, context) {
        this.parent = parent;
        this.context = context;
    }

    fatal(message, additionalContext = {}) {
        this.parent.fatal(message, { ...this.context, ...additionalContext });
    }

    error(message, additionalContext = {}) {
        this.parent.error(message, { ...this.context, ...additionalContext });
    }

    warn(message, additionalContext = {}) {
        this.parent.warn(message, { ...this.context, ...additionalContext });
    }

    info(message, additionalContext = {}) {
        this.parent.info(message, { ...this.context, ...additionalContext });
    }

    debug(message, additionalContext = {}) {
        this.parent.debug(message, { ...this.context, ...additionalContext });
    }

    trace(message, additionalContext = {}) {
        this.parent.trace(message, { ...this.context, ...additionalContext });
    }

    child(additionalContext) {
        return new ChildLogger(this.parent, { ...this.context, ...additionalContext });
    }

    isDebugEnabled() {
        return this.parent.isDebugEnabled();
    }

    isTraceEnabled() {
        return this.parent.isTraceEnabled();
    }
}

/**
 * Console Transport
 */
class ConsoleTransport {
    constructor(config) {
        this.config = config;
        this.stats = { messagesWritten: 0, errors: 0 };
        
        // Color codes for different levels
        this.colors = {
            fatal: '\x1b[35m', // Magenta
            error: '\x1b[31m', // Red
            warn: '\x1b[33m',  // Yellow
            info: '\x1b[36m',  // Cyan
            debug: '\x1b[32m', // Green
            trace: '\x1b[37m'  // White
        };
        this.reset = '\x1b[0m';
    }

    shouldHandle(level) {
        return true; // Console handles all levels
    }

    async write(entry) {
        try {
            const output = this.config.format === 'json' 
                ? this._formatJson(entry)
                : this._formatText(entry);
            
            if (entry.level === 'ERROR' || entry.level === 'FATAL') {
                console.error(output);
            } else {
                console.log(output);
            }
            
            this.stats.messagesWritten++;
        } catch (error) {
            this.stats.errors++;
            console.error('Console transport error:', error);
        }
    }

    _formatJson(entry) {
        return JSON.stringify(entry);
    }

    _formatText(entry) {
        const level = entry.level.toLowerCase();
        const color = this.config.colors ? this.colors[level] || '' : '';
        const reset = this.config.colors ? this.reset : '';
        
        let output = `${color}[${entry.timestamp}] ${entry.level}${reset}: ${entry.message}`;
        
        // Add context if present
        const context = { ...entry };
        delete context.timestamp;
        delete context.level;
        delete context.message;
        delete context.pid;
        delete context.hostname;
        delete context.memory;
        
        if (Object.keys(context).length > 0) {
            output += ` ${JSON.stringify(context)}`;
        }
        
        return output;
    }

    getStats() {
        return { ...this.stats };
    }
}

/**
 * File Transport
 */
class FileTransport {
    constructor(config) {
        this.config = config;
        this.stats = { messagesWritten: 0, errors: 0, bytesWritten: 0, rotations: 0 };
        this.currentFile = null;
        this.writeStream = null;
        
        this._ensureDirectory();
        this._openFile();
    }

    shouldHandle(level) {
        if (this.config.level) {
            const levels = { fatal: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 };
            const configLevel = levels[this.config.level] || levels.info;
            const messageLevel = levels[level] || levels.info;
            return messageLevel <= configLevel;
        }
        return true;
    }

    async write(entry) {
        try {
            if (!this.writeStream) {
                this._openFile();
            }
            
            const output = JSON.stringify(entry) + '\n';
            
            await new Promise((resolve, reject) => {
                this.writeStream.write(output, (error) => {
                    if (error) {
                        reject(error);
                    } else {
                        resolve();
                    }
                });
            });
            
            this.stats.messagesWritten++;
            this.stats.bytesWritten += Buffer.byteLength(output);
            
        } catch (error) {
            this.stats.errors++;
            console.error('File transport error:', error);
        }
    }

    rotateIfNeeded() {
        if (!this.currentFile || !fs.existsSync(this.currentFile)) {
            return;
        }
        
        try {
            const stats = fs.statSync(this.currentFile);
            if (stats.size >= this.config.maxSize) {
                this._rotateFile();
            }
        } catch (error) {
            console.error('Error checking file size for rotation:', error);
        }
    }

    _ensureDirectory() {
        if (!fs.existsSync(this.config.directory)) {
            fs.mkdirSync(this.config.directory, { recursive: true });
        }
    }

    _openFile() {
        this.currentFile = path.join(this.config.directory, this.config.filename);
        
        if (this.writeStream) {
            this.writeStream.end();
        }
        
        this.writeStream = fs.createWriteStream(this.currentFile, { flags: 'a' });
        
        this.writeStream.on('error', (error) => {
            console.error('Write stream error:', error);
            this.stats.errors++;
        });
    }

    _rotateFile() {
        try {
            if (this.writeStream) {
                this.writeStream.end();
                this.writeStream = null;
            }
            
            // Move current files
            for (let i = this.config.maxFiles - 1; i > 0; i--) {
                const oldFile = path.join(this.config.directory, `${this.config.filename}.${i}`);
                const newFile = path.join(this.config.directory, `${this.config.filename}.${i + 1}`);
                
                if (fs.existsSync(oldFile)) {
                    if (i === this.config.maxFiles - 1) {
                        fs.unlinkSync(oldFile); // Delete oldest
                    } else {
                        fs.renameSync(oldFile, newFile);
                    }
                }
            }
            
            // Move current file to .1
            const firstRotated = path.join(this.config.directory, `${this.config.filename}.1`);
            fs.renameSync(this.currentFile, firstRotated);
            
            // Compress if enabled
            if (this.config.compress) {
                this._compressFile(firstRotated);
            }
            
            // Open new file
            this._openFile();
            this.stats.rotations++;
            
        } catch (error) {
            console.error('Error rotating log file:', error);
            this.stats.errors++;
        }
    }

    _compressFile(filePath) {
        try {
            const zlib = require('zlib');
            const gzip = zlib.createGzip();
            const input = fs.createReadStream(filePath);
            const output = fs.createWriteStream(`${filePath}.gz`);
            
            input.pipe(gzip).pipe(output);
            
            output.on('finish', () => {
                fs.unlinkSync(filePath); // Remove uncompressed file
            });
            
        } catch (error) {
            console.error('Error compressing log file:', error);
        }
    }

    getStats() {
        return { ...this.stats };
    }
}

// Create and export default logger instance
const defaultLogger = new Logger({
    level: process.env.LOG_LEVEL || 'info',
    console: {
        enabled: true,
        colors: process.stdout.isTTY,
        timestamp: true
    },
    file: {
        enabled: process.env.NODE_ENV === 'production',
        directory: process.env.LOG_DIR || './logs',
        filename: 'photon-server.log'
    }
});

// Export both the Logger class and default instance
module.exports = defaultLogger;
module.exports.Logger = Logger;
module.exports.createLogger = (options) => new Logger(options);