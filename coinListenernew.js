// coinListener.js - Arduino Coin Selector Integration
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const Database = require('./database');

class CoinListener {
    constructor() {
        this.port = null;
        this.parser = null;
        this.isConnected = false;
        this.coinCallbacks = [];
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 8000; // 8 seconds - longer delay for USB hub stability
        this.database = new Database();
        
        // Coin values mapping (adjust based on your Arduino code)
        this.coinValues = {
            '1': 1,    // ₱1 coin
            '5': 5,    // ₱5 coin
            '10': 10,  // ₱10 coin
            '20': 20   // ₱20 coin
        };
        
        this.init();
    }
    
    init() {
        // Add delay on startup to allow USB hub to fully enumerate devices
        // This is especially important when Orange Pi boots with Arduino already connected
        const startupDelay = 5000; // 5 seconds
        console.log(`⏳ Waiting ${startupDelay/1000} seconds for USB devices to initialize...`);
        setTimeout(() => {
            console.log('🚀 Starting Arduino connection...');
            this.connectToArduino();
        }, startupDelay);
    }
    
    connectToArduino() {
        try {
            const configuredPort = (process.env.SERIAL_PORT || '').trim();
            if (configuredPort) {
                console.log(`🔌 Attempting to connect to Arduino on ${configuredPort} (from SERIAL_PORT)...`);
                this.tryNextPort([configuredPort], 0);
                return;
            }

            const isWindows = process.platform === 'win32';
            if (isWindows) {
                const comPorts = ['COM3'];
                console.log('🔌 Attempting to connect to Arduino on COM3...');
                this.tryNextPort(comPorts, 0);
                return;
            }

            console.log('🔌 Attempting to auto-detect Arduino serial port on Linux...');
            SerialPort.list().then((ports) => {
                const candidates = [];
                for (const p of ports) {
                    const pth = p.path;
                    if (!pth) continue;
                    if (pth.startsWith('/dev/ttyACM') || pth.startsWith('/dev/ttyUSB')) {
                        candidates.push(pth);
                    }
                }

                if (candidates.length === 0) {
                    console.error('❌ No Arduino serial ports found. Set SERIAL_PORT (e.g. /dev/ttyACM0)');
                    this.handleConnectionError();
                    return;
                }

                console.log('🔌 Found serial port candidates:', candidates.join(', '));
                this.tryNextPort(candidates, 0);
            }).catch((error) => {
                console.error('❌ Error listing serial ports:', error);
                this.handleConnectionError();
            });
        } catch (error) {
            console.error('❌ Error creating serial connection:', error);
            this.handleConnectionError();
        }
    }
    
    tryNextPort(comPorts, index) {
        if (index >= comPorts.length) {
            console.error('❌ All COM ports failed. Please check Arduino connection.');
            this.handleConnectionError();
            return;
        }
        
        const portPath = comPorts[index];
        console.log(`🔌 Trying to connect to ${portPath}...`);
        
        try {
            // Create serial port connection with proper settings for Linux/Armbian
            this.port = new SerialPort({
                path: portPath,
                baudRate: 9600,
                dataBits: 8,
                stopBits: 1,
                parity: 'none',
                rtscts: false,      // Disable hardware flow control (RTS/CTS)
                xon: false,         // Disable software flow control (XON)
                xoff: false,        // Disable software flow control (XOFF)
                xany: false,        // Disable software flow control (XANY)
                autoOpen: false
            });
            
            // Create parser for reading lines
            this.parser = this.port.pipe(new ReadlineParser({ delimiter: '\r\n' }));
            
            // Set up event handlers
            this.setupEventHandlers();
            
            // Open the port
            this.port.open((err) => {
                if (err) {
                    console.error(`❌ Failed to open ${portPath}:`, err.message);
                    
                    if (err.message.includes('Access denied')) {
                        console.log('⚠️ COM3 is busy (Arduino IDE might be using it)');
                        console.log('💡 Close Arduino IDE Serial Monitor or try again later');
                    }
                    
                    // Clean up and try to reconnect later
                    this.cleanup();
                    this.handleConnectionError();
                } else {
                    console.log(`✅ Successfully connected to Arduino on ${portPath}`);
                    this.isConnected = true;
                    this.reconnectAttempts = 0;
                    
                    // Reset Arduino by toggling DTR (simulates unplug/replug)
                    console.log('🔄 Resetting Arduino communication...');
                    this.port.set({ dtr: false, rts: false }, () => {
                        setTimeout(() => {
                            this.port.set({ dtr: true, rts: false }, () => {
                                console.log('✅ Arduino reset complete');
                                // Wait for Arduino to boot and initialize (3 seconds for USB hub stability)
                                setTimeout(() => {
                                    console.log('📤 Sending initial handshake...');
                                    this.sendCommand('READY');
                                }, 3000);
                            });
                        }, 500);
                    });
                }
            });
        
        } catch (error) {
            console.error(`❌ Error creating connection to ${portPath}:`, error);
            // Try next port
            setTimeout(() => {
                this.tryNextPort(comPorts, index + 1);
            }, 500);
        }
    }
    
    setupEventHandlers() {
        // Handle data from Arduino
        this.parser.on('data', (data) => {
            this.handleArduinoData(data.trim());
        });
        
        // Handle port open
        this.port.on('open', () => {
            console.log('🔌 Serial port opened successfully');
        });
        
        // Handle port close
        this.port.on('close', () => {
            console.log('🔌 Serial port closed');
            this.isConnected = false;
            this.handleConnectionError();
        });
        
        // Handle errors
        this.port.on('error', (err) => {
            console.error('❌ Serial port error:', err);
            this.isConnected = false;
            this.handleConnectionError();
        });
    }
    
    handleArduinoData(data) {
        console.log(`📡 Arduino data received: "${data}"`);
        
        // Parse coin detection messages
        if (data.startsWith('COIN:')) {
            const coinType = data.substring(5).trim();
            this.handleCoinDetection(coinType);
        }
        // Parse status messages
        else if (data.startsWith('STATUS:')) {
            const status = data.substring(7).trim();
            console.log(`📊 Arduino status: ${status}`);
        }
        // Parse error messages
        else if (data.startsWith('ERROR:')) {
            const error = data.substring(6).trim();
            console.error(`❌ Arduino error: ${error}`);
        }
        // Parse ready message
        else if (data === 'READY') {
            console.log('✅ Arduino is ready');
        }
        // Parse unknown messages
        else {
            console.log(`❓ Unknown Arduino message: "${data}"`);
        }
    }
    
    handleCoinDetection(coinType) {
        const coinValue = this.coinValues[coinType];
        
        if (coinValue) {
            console.log(`🪙 Coin detected: ₱${coinValue} (${coinType})`);
            
            // Notify all registered callbacks (they will handle session-specific recording)
            this.coinCallbacks.forEach(callback => {
                try {
                    callback(coinValue, coinType);
                } catch (error) {
                    console.error('Error in coin callback:', error);
                }
            });
        } else {
            console.warn(`⚠️ Unknown coin type: ${coinType}`);
        }
    }
    
    sendCommand(command) {
        if (this.isConnected && this.port) {
            try {
                this.port.write(command + '\n', (err) => {
                    if (err) {
                        console.error('❌ Error sending command to Arduino:', err);
                    } else {
                        console.log(`📤 Command sent to Arduino: ${command}`);
                    }
                });
            } catch (error) {
                console.error('❌ Error sending command:', error);
            }
        } else {
            console.warn('⚠️ Cannot send command - Arduino not connected');
        }
    }
    
    handleConnectionError() {
        this.isConnected = false;
        
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            console.log(`🔄 Reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${this.reconnectDelay/1000}s...`);
            
            setTimeout(() => {
                this.connectToArduino();
            }, this.reconnectDelay);
        } else {
            console.error('❌ Max reconnection attempts reached. Please check Arduino connection.');
        }
    }
    
    // Register callback for coin detection
    onCoinDetected(callback) {
        this.coinCallbacks.push(callback);
        console.log('📝 Coin detection callback registered');
    }
    
    // Remove callback
    removeCallback(callback) {
        const index = this.coinCallbacks.indexOf(callback);
        if (index > -1) {
            this.coinCallbacks.splice(index, 1);
            console.log('📝 Coin detection callback removed');
        }
    }
    
    // Get connection status
    getConnectionStatus() {
        return {
            isConnected: this.isConnected,
            port: this.port ? this.port.path : null,
            reconnectAttempts: this.reconnectAttempts
        };
    }
    
    // Test connection
    testConnection() {
        if (this.isConnected) {
            this.sendCommand('TEST');
            return true;
        }
        return false;
    }
    
    // Manually set COM port
    setComPort(portPath) {
        if (this.isConnected) {
            console.log('🔌 Disconnecting from current port...');
            this.cleanup();
        }
        
        console.log(`🔌 Manually setting COM port to ${portPath}`);
        setTimeout(() => {
            this.tryNextPort([portPath], 0);
        }, 1000);
    }
    
    // Cleanup
    cleanup() {
        if (this.port && this.port.isOpen) {
            this.port.close();
        }
        this.isConnected = false;
        console.log('🧹 Coin listener cleaned up');
    }
}

// Create and export the coin listener instance
const coinListener = new CoinListener();

// Handle process termination
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down coin listener...');
    coinListener.cleanup();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Shutting down coin listener...');
    coinListener.cleanup();
    process.exit(0);
});

module.exports = coinListener;
