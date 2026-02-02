// Quick script to check coin data in database
const Database = require('./database');

async function checkCoins() {
    const db = new Database();
    
    try {
        const today = new Date().toISOString().split('T')[0];
        console.log('Checking coins for date:', today);
        
        // Get coins from database
        const coins = await db.getDailyCoinsRange(today, today);
        
        console.log('\n📊 Coin Breakdown:');
        console.log('==================');
        console.log('Raw data from database:');
        console.log(coins);
        
        console.log('\n💰 By coin type:');
        coins.forEach(coin => {
            console.log(`  Coin Type: "${coin.coin_type}" (${typeof coin.coin_type})`);
            console.log(`  Coin Value: ${coin.coin_value}`);
            console.log(`  Count: ${coin.count}`);
            console.log(`  Total Value: ₱${coin.total_value}`);
            console.log('  ---');
        });
        
        // Check if coin_type is number or string
        const coin1Count = coins.find(c => c.coin_type === '1' || c.coin_type === 1)?.count || 0;
        const coin5Count = coins.find(c => c.coin_type === '5' || c.coin_type === 5)?.count || 0;
        const coin10Count = coins.find(c => c.coin_type === '10' || c.coin_type === 10)?.count || 0;
        const coin20Count = coins.find(c => c.coin_type === '20' || c.coin_type === 20)?.count || 0;
        
        console.log('\n🪙 Counts:');
        console.log('  ₱1:', coin1Count);
        console.log('  ₱5:', coin5Count);
        console.log('  ₱10:', coin10Count);
        console.log('  ₱20:', coin20Count);
        
    } catch (error) {
        console.error('Error:', error);
    } finally {
        process.exit(0);
    }
}

checkCoins();
