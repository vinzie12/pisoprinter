// cleanup_database.js - Database cleanup and truncation utility
const Database = require('./database');

class DatabaseCleanup {
    constructor() {
        this.db = new Database();
    }

    // Clear all data but keep structure
    async clearAllData() {
        console.log('🧹 Clearing all data from database...');
        
        try {
            await this.clearDailyCoins();
            await this.clearDailySummaries();
            await this.clearPrintTransactions();
            await this.clearAnomalies();
            
            console.log('✅ All data cleared successfully');
        } catch (error) {
            console.error('❌ Error clearing data:', error);
        }
    }

    // Clear only coin data
    async clearDailyCoins() {
        return new Promise((resolve, reject) => {
            const sql = 'DELETE FROM daily_coins';
            this.db.db.run(sql, (err) => {
                if (err) {
                    console.error('❌ Error clearing daily coins:', err);
                    reject(err);
                } else {
                    console.log('✅ Daily coins data cleared');
                    resolve();
                }
            });
        });
    }

    // Clear only summary data
    async clearDailySummaries() {
        return new Promise((resolve, reject) => {
            const sql = 'DELETE FROM daily_summaries';
            this.db.db.run(sql, (err) => {
                if (err) {
                    console.error('❌ Error clearing daily summaries:', err);
                    reject(err);
                } else {
                    console.log('✅ Daily summaries data cleared');
                    resolve();
                }
            });
        });
    }

    // Clear only print transactions
    async clearPrintTransactions() {
        return new Promise((resolve, reject) => {
            const sql = 'DELETE FROM print_transactions';
            this.db.db.run(sql, (err) => {
                if (err) {
                    console.error('❌ Error clearing print transactions:', err);
                    reject(err);
                } else {
                    console.log('✅ Print transactions data cleared');
                    resolve();
                }
            });
        });
    }

    // Clear only anomalies
    async clearAnomalies() {
        return new Promise((resolve, reject) => {
            const sql = 'DELETE FROM anomalies';
            this.db.db.run(sql, (err) => {
                if (err) {
                    console.error('❌ Error clearing anomalies:', err);
                    reject(err);
                } else {
                    console.log('✅ Anomalies data cleared');
                    resolve();
                }
            });
        });
    }

    // Clear data older than X days
    async clearOldData(daysOld = 30) {
        console.log(`🧹 Clearing data older than ${daysOld} days...`);
        
        try {
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - daysOld);
            const cutoffString = cutoffDate.toISOString().split('T')[0];
            
            // Clear old daily coins
            await this.clearOldDailyCoins(cutoffString);
            
            // Clear old daily summaries
            await this.clearOldDailySummaries(cutoffString);
            
            // Clear old print transactions
            await this.clearOldPrintTransactions(cutoffString);
            
            // Clear old anomalies
            await this.clearOldAnomalies(cutoffString);
            
            console.log(`✅ Data older than ${daysOld} days cleared successfully`);
        } catch (error) {
            console.error('❌ Error clearing old data:', error);
        }
    }

    // Clear old daily coins
    async clearOldDailyCoins(cutoffDate) {
        return new Promise((resolve, reject) => {
            const sql = 'DELETE FROM daily_coins WHERE date < ?';
            this.db.db.run(sql, [cutoffDate], (err) => {
                if (err) {
                    console.error('❌ Error clearing old daily coins:', err);
                    reject(err);
                } else {
                    console.log('✅ Old daily coins data cleared');
                    resolve();
                }
            });
        });
    }

    // Clear old daily summaries
    async clearOldDailySummaries(cutoffDate) {
        return new Promise((resolve, reject) => {
            const sql = 'DELETE FROM daily_summaries WHERE date < ?';
            this.db.db.run(sql, [cutoffDate], (err) => {
                if (err) {
                    console.error('❌ Error clearing old daily summaries:', err);
                    reject(err);
                } else {
                    console.log('✅ Old daily summaries data cleared');
                    resolve();
                }
            });
        });
    }

    // Clear old print transactions
    async clearOldPrintTransactions(cutoffDate) {
        return new Promise((resolve, reject) => {
            const sql = 'DELETE FROM print_transactions WHERE date < ?';
            this.db.db.run(sql, [cutoffDate], (err) => {
                if (err) {
                    console.error('❌ Error clearing old print transactions:', err);
                    reject(err);
                } else {
                    console.log('✅ Old print transactions data cleared');
                    resolve();
                }
            });
        });
    }

    // Clear old anomalies
    async clearOldAnomalies(cutoffDate) {
        return new Promise((resolve, reject) => {
            const sql = 'DELETE FROM anomalies WHERE date < ?';
            this.db.db.run(sql, [cutoffDate], (err) => {
                if (err) {
                    console.error('❌ Error clearing old anomalies:', err);
                    reject(err);
                } else {
                    console.log('✅ Old anomalies data cleared');
                    resolve();
                }
            });
        });
    }

    // Reset auto-increment counters
    async resetCounters() {
        console.log('🔄 Resetting auto-increment counters...');
        
        try {
            await this.resetCounter('daily_coins');
            await this.resetCounter('daily_summaries');
            await this.resetCounter('print_transactions');
            await this.resetCounter('anomalies');
            
            console.log('✅ Auto-increment counters reset successfully');
        } catch (error) {
            console.error('❌ Error resetting counters:', error);
        }
    }

    // Reset specific table counter
    async resetCounter(tableName) {
        return new Promise((resolve, reject) => {
            const sql = `DELETE FROM sqlite_sequence WHERE name = ?`;
            this.db.db.run(sql, [tableName], (err) => {
                if (err) {
                    console.error(`❌ Error resetting counter for ${tableName}:`, err);
                    reject(err);
                } else {
                    console.log(`✅ Counter reset for ${tableName}`);
                    resolve();
                }
            });
        });
    }

    // Show current database size
    async showDatabaseStats() {
        console.log('📊 Current Database Statistics:');
        
        try {
            const stats = await this.getTableStats();
            
            console.log('📋 Table Row Counts:');
            console.log(`  - Daily Coins: ${stats.dailyCoins} rows`);
            console.log(`  - Daily Summaries: ${stats.dailySummaries} rows`);
            console.log(`  - Print Transactions: ${stats.printTransactions} rows`);
            console.log(`  - Anomalies: ${stats.anomalies} rows`);
            
            console.log(`📅 Date Range: ${stats.oldestDate} to ${stats.newestDate}`);
            console.log(`💰 Total Value: ₱${stats.totalValue}`);
            
        } catch (error) {
            console.error('❌ Error getting database stats:', error);
        }
    }

    // Get table statistics
    async getTableStats() {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT 
                    (SELECT COUNT(*) FROM daily_coins) as daily_coins,
                    (SELECT COUNT(*) FROM daily_summaries) as daily_summaries,
                    (SELECT COUNT(*) FROM print_transactions) as print_transactions,
                    (SELECT COUNT(*) FROM anomalies) as anomalies,
                    (SELECT MIN(date) FROM daily_summaries) as oldest_date,
                    (SELECT MAX(date) FROM daily_summaries) as newest_date,
                    (SELECT SUM(total_value) FROM daily_summaries) as total_value
            `;
            
            this.db.db.get(sql, (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve({
                        dailyCoins: row.daily_coins || 0,
                        dailySummaries: row.daily_summaries || 0,
                        printTransactions: row.print_transactions || 0,
                        anomalies: row.anomalies || 0,
                        oldestDate: row.oldest_date || 'No data',
                        newestDate: row.newest_date || 'No data',
                        totalValue: row.total_value || 0
                    });
                }
            });
        });
    }

    // Close database connection
    close() {
        if (this.db) {
            this.db.close();
        }
    }
}

// Command line interface
async function main() {
    const args = process.argv.slice(2);
    const command = args[0];
    const days = parseInt(args[1]) || 30;
    
    const cleanup = new DatabaseCleanup();
    
    try {
        switch (command) {
            case 'all':
                await cleanup.clearAllData();
                break;
            case 'old':
                await cleanup.clearOldData(days);
                break;
            case 'coins':
                await cleanup.clearDailyCoins();
                break;
            case 'summaries':
                await cleanup.clearDailySummaries();
                break;
            case 'transactions':
                await cleanup.clearPrintTransactions();
                break;
            case 'anomalies':
                await cleanup.clearAnomalies();
                break;
            case 'reset-counters':
                await cleanup.resetCounters();
                break;
            case 'stats':
                await cleanup.showDatabaseStats();
                break;
            default:
                console.log('🗑️ Piso Printer Database Cleanup Utility');
                console.log('');
                console.log('Usage: node cleanup_database.js <command> [days]');
                console.log('');
                console.log('Commands:');
                console.log('  all              - Clear all data');
                console.log('  old [days]       - Clear data older than X days (default: 30)');
                console.log('  coins            - Clear only coin data');
                console.log('  summaries        - Clear only summary data');
                console.log('  transactions     - Clear only print transaction data');
                console.log('  anomalies        - Clear only anomaly data');
                console.log('  reset-counters   - Reset auto-increment counters');
                console.log('  stats            - Show current database statistics');
                console.log('');
                console.log('Examples:');
                console.log('  node cleanup_database.js all');
                console.log('  node cleanup_database.js old 7');
                console.log('  node cleanup_database.js coins');
                console.log('  node cleanup_database.js stats');
        }
    } catch (error) {
        console.error('❌ Cleanup failed:', error);
    } finally {
        cleanup.close();
    }
}

// Run if called directly
if (require.main === module) {
    main();
}

module.exports = DatabaseCleanup;
