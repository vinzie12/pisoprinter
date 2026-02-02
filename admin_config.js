// admin_config.js - Admin credentials configuration
// IMPORTANT: Change these credentials in production!

module.exports = {
    // User accounts with roles
    USERS: {
        superadmin: {
            username: 'superadmin',
            password: 'superadmin123',
            role: 'superadmin',
            permissions: ['all'] // Can access everything
        },
        admin: {
            username: 'admin',
            password: 'admin123',
            role: 'admin',
            permissions: ['dashboard', 'settings', 'refresh'] // Limited permissions
        }
    },
    
    // Admin token (should be a secure random string in production)
    ADMIN_TOKEN: 'admin123',
    
    // Session timeout (in milliseconds) - 8 hours
    SESSION_TIMEOUT: 28800000 * 60 * 60 * 1000,
    
    // Maximum login attempts before temporary lockout
    MAX_LOGIN_ATTEMPTS: 5,
    
    // Lockout duration (in milliseconds) - 15 minutes
    LOCKOUT_DURATION: 900000 * 60 * 1000
};
