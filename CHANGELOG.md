# Changelog

All notable changes to Piso Printer will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Queue management system with session-based payment control
- Arduino coin selector integration with relay control
- Real-time queue status and position tracking
- Admin panel for printer configuration and monitoring
- Captive portal support for public WiFi deployment
- Multi-format document support (PDF, DOCX, DOC)
- Automatic page counting from document properties
- SQLite database for transaction logging
- Cross-platform printer support (Windows CUPS/Linux)
- Responsive mobile-friendly interface
- Payment timeout handling with queue advancement

### Fixed
- Coin selector now properly re-enables for next active queued user
- Coins are only accepted when session is active (not waiting)
- Queue properly advances after user completion or timeout
- DOCX page counting now matches Microsoft Word exactly
- Timer continues during actual printing process
- Memory leaks from unlimited queue growth prevented
- Coin routing to correct device in multi-user scenarios

### Security
- Hardware-controlled coin acceptance via relay
- Session-based payment validation
- Automatic cleanup of temporary files
- Queue size limits to prevent resource exhaustion

## [1.0.0] - 2025-01-19

### Added
- Initial release of Piso Printer system
- Basic coin-operated printing functionality
- Arduino integration for coin detection
- Simple file upload and printing
- Basic cost calculation
- Single-user operation

### Known Limitations
- No queue management (first-come, first-served)
- Limited to one user at a time
- Basic error handling
- No admin interface
- Manual printer configuration required

---

## Version History

### v1.0.0 (2025-01-19)
- **MVP Release**: Basic coin-operated printing
- **Core Features**: File upload, coin detection, printing
- **Hardware**: Arduino + coin selector + relay control
- **Platform**: Windows-focused with basic Linux support

### v1.1.0 (Upcoming)
- **Queue Management**: Multi-user support with session handling
- **Enhanced Security**: Hardware-enforced payment control
- **Admin Panel**: Web-based configuration interface
- **Cross-Platform**: Full Linux/Armbian support with CUPS
- **Captive Portal**: Public deployment ready
- **Mobile Support**: Responsive design for all devices

---

## Breaking Changes

### From v1.0.0 to v1.1.0
- **Queue System**: Single-user operation replaced with queue management
- **Arduino Firmware**: Updated to include relay control commands
- **API Changes**: New queue-related endpoints added
- **Database**: SQLite database now required for transaction logging
- **Configuration**: New configuration files for pricing and printer settings

---

## Migration Guide

### Upgrading from v1.0.0 to v1.1.0

1. **Backup existing data**
   ```bash
   cp db.sqlite db.sqlite.backup
   ```

2. **Update Arduino firmware**
   - Flash new `arduino_coin_selector.ino`
   - Update wiring to include relay control

3. **Install dependencies**
   ```bash
   npm install
   ```

4. **Update configuration**
   - Add `pricing-config.json`
   - Update `printer_config.js` if needed

5. **Test queue functionality**
   - Verify multi-user scenarios work correctly
   - Test coin selector relay control

---

## Technical Debt

### Future Improvements
- [ ] Add comprehensive test suite
- [ ] Implement proper error recovery
- [ ] Add configuration validation
- [ ] Improve logging and monitoring
- [ ] Add API rate limiting
- [ ] Implement user authentication
- [ ] Add backup/restore functionality

### Performance Optimizations
- [ ] Optimize database queries
- [ ] Implement file caching
- [ ] Add connection pooling
- [ ] Optimize Arduino communication

---

## Security Updates

### v1.1.0
- Added hardware-enforced payment validation
- Implemented session-based coin control
- Added automatic file cleanup
- Implemented queue size limits
- Enhanced input validation

### v1.0.0
- Basic input sanitization
- Simple file type validation

---

## Dependencies

### Current Dependencies
- Node.js 16+
- Arduino with coin selector
- SQLite3
- Express.js
- SerialPort
- Mammoth (DOCX processing)
- PDF-lib (PDF generation)

### Updated Dependencies
- Upgraded SerialPort to v13.0.0
- Updated Express.js to v4.21.2
- Added pdf-lib for PDF processing
- Added mammoth for DOCX handling

---

## Support

For questions about upgrading or troubleshooting:
- Check the [Troubleshooting](README.md#-troubleshooting) section
- Create an issue on GitHub
- Review the [API documentation](README.md#-api-endpoints)

---

*Note: This changelog covers only major changes. For detailed commit history, please see the Git repository.*
