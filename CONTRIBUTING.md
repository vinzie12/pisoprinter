# Contributing to Piso Printer

Thank you for your interest in contributing to Piso Printer! This document provides guidelines for contributors.

## 🤝 How to Contribute

### Reporting Bugs

1. **Search existing issues** first to avoid duplicates
2. **Use the bug report template** and provide:
   - Clear description of the issue
   - Steps to reproduce
   - Expected vs actual behavior
   - Environment details (OS, Node.js version, Arduino model)
   - Relevant logs or screenshots

### Suggesting Features

1. **Check existing feature requests**
2. **Use the feature request template** and include:
   - Clear problem statement
   - Proposed solution
   - Implementation ideas (if any)
   - Potential impact on users

### Code Contributions

#### Setup Development Environment

1. Fork the repository
2. Clone your fork locally
3. Install dependencies:
   ```bash
   npm install
   ```
4. Create a new branch:
   ```bash
   git checkout -b feature/your-feature-name
   ```

#### Development Guidelines

- **Follow existing code style** (ES6+ where appropriate)
- **Add comments** for complex logic
- **Update documentation** for new features
- **Test your changes** thoroughly
- **Ensure no console errors** in browser
- **Check Arduino compatibility** if modifying coin selector logic

#### Commit Guidelines

- **Use clear, descriptive commit messages**
- **Prefix commits with type:**
  - `feat:` New feature
  - `fix:` Bug fix
  - `docs:` Documentation changes
  - `style:` Code formatting (no functional changes)
  - `refactor:` Code refactoring
  - `test:` Adding or updating tests
  - `chore:` Maintenance tasks

Examples:
```
feat: add multi-language support
fix: resolve queue timeout issue
docs: update Arduino setup instructions
```

#### Pull Request Process

1. **Update README.md** if you've added features
2. **Add tests** for new functionality
3. **Ensure all tests pass**
4. **Update CHANGELOG.md** if applicable
5. **Submit a pull request** with:
   - Clear title and description
   - Reference related issues
   - Screenshots for UI changes
   - Testing instructions

## 🏗️ Project Structure

```
pisoprinter/
├── public/                 # Frontend files
│   ├── index.html         # Main user interface
│   └── admin.html         # Admin panel
├── arduino11262025/       # Arduino firmware
├── server.js              # Main server application
├── queue-manager.js       # Queue management
├── coinListener.js        # Arduino communication
├── printer.js             # Printer integration
├── database.js            # Database operations
└── tests/                 # Test files (if added)
```

## 🧪 Testing

### Manual Testing Checklist

- [ ] File upload works for PDF, DOCX, DOC
- [ ] Page counting is accurate
- [ ] Queue management functions correctly
- [ ] Coin selector responds to commands
- [ ] Printing completes successfully
- [ ] Admin panel functions properly
- [ ] Responsive design works on mobile
- [ ] Error handling works gracefully

### Test Scenarios

1. **Single User Flow**
   - Upload → Calculate cost → Pay → Print

2. **Multi-User Queue**
   - Multiple users joining queue
   - Queue advancement after completion
   - Timeout handling

3. **Error Conditions**
   - Invalid file formats
   - Printer offline
   - Arduino disconnected
   - Network issues

## 📝 Documentation

- **README.md**: Project overview and setup
- **API Documentation**: Endpoint descriptions
- **Arduino Setup**: Hardware configuration
- **Deployment Guide**: Production setup

## 🎯 Areas for Contribution

### High Priority
- [ ] Add comprehensive test suite
- [ ] Improve error handling and logging
- [ ] Add internationalization support
- [ ] Enhance mobile responsiveness

### Medium Priority
- [ ] Add more printer models support
- [ ] Implement user authentication
- [ ] Add export functionality for transaction data
- [ ] Create Docker deployment setup

### Low Priority
- [ ] Add themes/customization options
- [ ] Implement analytics tracking
- [ ] Add backup/restore functionality
- [ ] Create mobile companion app

## 🔧 Development Tools

### Recommended VS Code Extensions
- ES6 String HTML
- Prettier - Code formatter
- ESLint
- GitLens
- Arduino (if working on firmware)

### Debugging
- Use browser DevTools for frontend issues
- Check Arduino Serial Monitor for hardware issues
- Review server logs for backend problems
- Use SQLite browser for database inspection

## 📋 Code Review Process

1. **Automated Checks**
   - Code style validation
   - Basic functionality tests

2. **Manual Review**
   - Code quality and maintainability
   - Security considerations
   - Performance impact
   - Documentation completeness

3. **Testing**
   - Manual testing by maintainer
   - Integration testing if needed

## 🚀 Release Process

1. **Version bump** in package.json
2. **Update CHANGELOG.md**
3. **Create Git tag**
4. **Generate release notes**
5. **Deploy to production**

## 💬 Communication

- **GitHub Issues**: Bug reports and feature requests
- **Discussions**: General questions and ideas
- **Pull Requests**: Code contributions

## 📄 License

By contributing, you agree that your contributions will be licensed under the ISC License, same as the project.

## 🙏 Recognition

Contributors will be:
- Listed in README.md
- Mentioned in release notes
- Invited to join maintainer team (for significant contributions)

Thank you for helping improve Piso Printer! 🚀
