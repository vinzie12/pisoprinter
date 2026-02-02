// server.js (partial)
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { exec, execFile } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const mammoth = require('mammoth');
const { printFile, getPrinters, testPrinter, testPowerShell, getDetailedPrinterStatus, isPrinterReady, getPrinterConfig, updatePrinterConfig, setDefaultPrinter, refreshAvailablePrinters, testPrinterConfiguration } = require('./printer');
const coinListener = require('./coinListener');
const queueManager = require('./queue-manager');

const app = express();
const upload = multer({ dest: 'uploads/' });

const IS_WINDOWS = process.platform === 'win32';
const CAPTIVE_PORTAL_URL = process.env.CAPTIVE_PORTAL_URL || 'http://10.0.0.1/';

async function runCupsCommand(cmd, args, options = {}) {
    const timeout = options.timeout || 30000;

    const resolveCandidates = (base) => {
        const name = (base || '').trim();
        if (!name) return [];
        return [name, `/usr/sbin/${name}`, `/usr/bin/${name}`];
    };

    const attempt = async (useSudo) => {
        const candidates = resolveCandidates(cmd);
        let lastErr = null;

        for (const candidate of candidates) {
            try {
                if (useSudo) {
                    const r = await execFileAsync('sudo', ['-n', candidate, ...(args || [])], { timeout });
                    return { stdout: r.stdout || '', stderr: r.stderr || '', usedSudo: true };
                }
                const r = await execFileAsync(candidate, args || [], { timeout });
                return { stdout: r.stdout || '', stderr: r.stderr || '', usedSudo: false };
            } catch (e) {
                lastErr = e;
                if (e && (e.code === 'ENOENT' || e.errno === 'ENOENT')) {
                    continue;
                }
                throw e;
            }
        }

        throw lastErr || new Error('CUPS command not found');
    };

    try {
        return await attempt(false);
    } catch (e) {
        const stderr = (e && e.stderr) ? String(e.stderr) : '';
        const stdout = (e && e.stdout) ? String(e.stdout) : '';
        const combined = `${stdout}\n${stderr}`;

        if (/forbidden|not\s+authorized|permission|not\s+permitted/i.test(combined)) {
            try {
                return await attempt(true);
            } catch (sudoErr) {
                const sudoStderr = (sudoErr && sudoErr.stderr) ? String(sudoErr.stderr) : '';
                const sudoStdout = (sudoErr && sudoErr.stdout) ? String(sudoErr.stdout) : '';
                const sudoCombined = `${sudoStdout}\n${sudoStderr}`;
                const needsSudo = /password|sudo:|not\s+allowed/i.test(sudoCombined);
                const err = new Error(sudoCombined.trim() || combined.trim() || 'CUPS command failed');
                err.needsSudo = needsSudo;
                throw err;
            }
        }

        const err = new Error(combined.trim() || (e && e.message) || 'CUPS command failed');
        throw err;
    }
}

app.use(express.static('public', { index: false }));
app.use(express.json());
app.get('/generate_204', (req, res) => {
    res.redirect(302, CAPTIVE_PORTAL_URL);
});

app.get('/hotspot-detect.html', (req, res) => {
    res.redirect(302, CAPTIVE_PORTAL_URL);
});

app.get('/ncsi.txt', (req, res) => {
    res.redirect(302, CAPTIVE_PORTAL_URL);
});

app.get('/connecttest.txt', (req, res) => {
    res.redirect(302, CAPTIVE_PORTAL_URL);
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'log.html'));
});

app.get('/log.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'log.html'));
});

app.get('/app', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Ensure we can serve uploaded files publicly at /uploads
app.use('/uploads', express.static('uploads'));

// Arduino Coin Listener Integration
const Database = require('./database');

coinListener.onCoinDetected((coinValue, coinType) => {
    console.log(`🪙 Coin detected via Arduino: ₱${coinValue} (${coinType})`);
    
    // Record coin in database for daily tracking
    const db = new Database();
    db.recordCoin(coinValue, coinType).then(() => {
        console.log(`✅ Coin ₱${coinValue} recorded successfully`);
    }).catch(error => {
        console.error('Error recording coin in database:', error);
    }).finally(() => {
        db.close();
    });
    
    // Store for UI display
    global.lastCoinDetected = {
        value: coinValue,
        type: coinType,
        timestamp: Date.now()
    };
});

console.log('🔌 Arduino coin listener initialized');

// Saved files retention settings
const SAVED_DIR = path.join('uploads', 'saved');
const SAVED_TTL_MS = 30 * 60 * 1000; // 30 minutes

function ensureDirectoryExists(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function sanitizeFileName(name) {
    // Remove path separators and unsafe characters
    return name.replace(/[^a-zA-Z0-9._ -]/g, '').replace(/[\\/]+/g, '').trim() || 'file';
}

function buildSavedPath(originalName, fallbackExt = '') {
    const hasExt = path.extname(originalName);
    const ext = hasExt ? hasExt : fallbackExt;
    const base = sanitizeFileName(hasExt ? path.basename(originalName, hasExt) : originalName);
    const filename = `${base}_${Date.now()}${ext}`;
    return path.join(SAVED_DIR, filename);
}

function isExpired(filePath, now = Date.now()) {
    try {
        const stat = fs.statSync(filePath);
        return now - stat.mtimeMs > SAVED_TTL_MS;
    } catch (_) {
        return true;
    }
}

function cleanupExpiredSavedFiles() {
    ensureDirectoryExists(SAVED_DIR);
    const now = Date.now();
    let cleanedCount = 0;
    
    try {
        const files = fs.readdirSync(SAVED_DIR);
        for (const name of files) {
            const full = path.join(SAVED_DIR, name);
            try {
                const stat = fs.statSync(full);
                if (!stat.isFile()) continue;
                if (now - stat.mtimeMs > SAVED_TTL_MS) {
                    fs.unlinkSync(full);
                    cleanedCount++;
                }
            } catch (_) {
                // ignore
            }
        }
        if (cleanedCount > 0) {
            console.log(`🧹 Cleaned up ${cleanedCount} expired saved files (older than 30 minutes)`);
        }
    } catch (error) {
        console.log('Error during saved files cleanup:', error.message);
    }
}

// Clean up temporary files in the main uploads folder
function cleanupTempUploadFiles() {
    const uploadsDir = 'uploads/';
    if (!fs.existsSync(uploadsDir)) return;
    
    const now = Date.now();
    const tempFileTTL = 30 * 60 * 1000; // 30 minutes for temp files
    let cleanedCount = 0;
    
    try {
        const files = fs.readdirSync(uploadsDir);
        for (const name of files) {
            // Skip the 'saved' subdirectory (handled by cleanupExpiredSavedFiles)
            if (name === 'saved') continue;
            
            const full = path.join(uploadsDir, name);
            try {
                const stat = fs.statSync(full);
                if (!stat.isFile()) continue;
                
                // Check if file is older than 5 minutes
                if (now - stat.mtimeMs > tempFileTTL) {
                    fs.unlinkSync(full);
                    cleanedCount++;
                }
            } catch (error) {
                console.log(`Error checking file ${name}:`, error.message);
            }
        }
        if (cleanedCount > 0) {
            console.log(`🧹 Cleaned up ${cleanedCount} expired temp upload files (older than 30 minutes)`);
        }
    } catch (error) {
        console.log('Error during temp file cleanup:', error.message);
    }
}

// Run cleanup every 2 minutes (since files expire in 30 minutes)
setInterval(cleanupExpiredSavedFiles, 2 * 60 * 1000);
setInterval(cleanupTempUploadFiles, 2 * 60 * 1000);

// Resolve LibreOffice executable across OSes (libreoffice/soffice)
let cachedLibreOfficeCmd = null;
async function resolveLibreOfficeCmd() {
    if (cachedLibreOfficeCmd) {
        return cachedLibreOfficeCmd;
    }

    const isWindows = process.platform === 'win32';
    const candidateCommands = [];

    // Common CLI names
    candidateCommands.push('libreoffice');
    candidateCommands.push('soffice');

    // Well-known Windows install paths
    if (isWindows) {
        const windowsCandidates = [
            'C:/Program Files/LibreOffice/program/soffice.exe',
            'C:/Program Files (x86)/LibreOffice/program/soffice.exe',
        ];
        for (const p of windowsCandidates) {
            if (fs.existsSync(p)) {
                candidateCommands.push(p);
            }
        }
    }

    for (const cmd of candidateCommands) {
        try {
            await execAsync(`"${cmd}" --version`);
            cachedLibreOfficeCmd = cmd;
            return cachedLibreOfficeCmd;
        } catch (_) {
            // try next
        }
    }
    return null;
}

// Function to check if LibreOffice is available
async function checkLibreOffice() {
    const cmd = await resolveLibreOfficeCmd();
    const available = Boolean(cmd);
    if (!available) {
        console.log('LibreOffice/soffice not found, falling back to alternative methods');
    }
    return available;
}

// Function to convert DOCX to PDF using Mammoth + PDF-Lib (NO LibreOffice needed)
async function convertDocxToPdf(inputPath, outputPath) {
    try {
        console.log(`🔄 Converting DOCX to PDF: ${inputPath} → ${outputPath}`);
        
        // Step 1: Extract text and formatting from DOCX using Mammoth
        const docxBuffer = fs.readFileSync(inputPath);
        const result = await mammoth.convertToHtml({ buffer: docxBuffer });
        const html = result.value;
        
        if (!html || html.trim().length === 0) {
            console.warn('⚠️ DOCX extraction resulted in empty content');
            return false;
        }
        
        console.log(`✅ Extracted HTML from DOCX (${html.length} chars)`);
        
        // Step 2: Create PDF from extracted HTML using pdf-lib (pure JavaScript, no external tools)
        console.log('📄 Creating PDF from extracted content using pdf-lib...');
        const { PDFDocument, rgb } = require('pdf-lib');
        const pdfDoc = await PDFDocument.create();
        
        // Parse HTML and convert to formatted text
        const plainText = html
            .replace(/<br\s*\/?>/gi, '\n')           // Convert <br> to newlines
            .replace(/<\/p>/gi, '\n')                 // Convert </p> to newlines
            .replace(/<\/div>/gi, '\n')               // Convert </div> to newlines
            .replace(/<\/li>/gi, '\n')                // Convert </li> to newlines
            .replace(/<[^>]*>/g, '')                  // Remove all HTML tags
            .replace(/&nbsp;/g, ' ')                  // Convert &nbsp; to space
            .replace(/&lt;/g, '<')                    // Convert &lt; to <
            .replace(/&gt;/g, '>')                    // Convert &gt; to >
            .replace(/&amp;/g, '&')                   // Convert &amp; to &
            .replace(/&quot;/g, '"')                  // Convert &quot; to "
            .replace(/&apos;/g, "'")                  // Convert &apos; to '
            .split('\n')
            .map(line => line.trim())                 // Trim each line
            .filter(line => line.length > 0);         // Remove empty lines
        
        // PDF page settings
        const pageWidth = 612;  // Letter width in points
        const pageHeight = 792; // Letter height in points
        const margin = 40;
        const fontSize = 11;
        const lineHeight = 16;
        const maxCharsPerLine = 85;

        function sanitizePdfText(text) {
            if (!text) return '';
            return text
                .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '')
                .replace(/\u00A0/g, ' ')
                .replace(/\u00AD/g, '')
                .replace(/₱/g, 'PHP ')
                .replace(/[\u2018\u2019]/g, "'")
                .replace(/[\u201C\u201D]/g, '"')
                .replace(/[\u2013\u2014]/g, '-')
                .replace(/\u2022/g, '*')
                .normalize('NFKD')
                .replace(/[\u0300-\u036f]/g, '')
                .replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\u00FF]/g, '');
        }
        
        let currentPage = pdfDoc.addPage([pageWidth, pageHeight]);
        let yPosition = pageHeight - margin;
        
        // Helper function to wrap text
        function wrapText(text, maxChars) {
            const words = text.split(' ');
            const lines = [];
            let currentLine = '';
            
            for (const word of words) {
                const testLine = currentLine ? currentLine + ' ' + word : word;
                if (testLine.length > maxChars && currentLine) {
                    lines.push(currentLine);
                    currentLine = word;
                } else {
                    currentLine = testLine;
                }
            }
            if (currentLine) lines.push(currentLine);
            return lines;
        }
        
        // Draw text on pages
        for (const paragraph of plainText) {
            const safeParagraph = sanitizePdfText(paragraph);
            if (!safeParagraph) continue;
            const wrappedLines = wrapText(safeParagraph, maxCharsPerLine);
            
            for (const line of wrappedLines) {
                // Check if we need a new page
                if (yPosition < margin + lineHeight) {
                    currentPage = pdfDoc.addPage([pageWidth, pageHeight]);
                    yPosition = pageHeight - margin;
                }
                
                // Draw the line
                currentPage.drawText(line, {
                    x: margin,
                    y: yPosition,
                    size: fontSize,
                    color: rgb(0, 0, 0),
                    maxWidth: pageWidth - (margin * 2)
                });
                
                yPosition -= lineHeight;
            }
            
            // Add extra space between paragraphs
            yPosition -= 5;
        }
        
        // Save PDF
        const pdfBytes = await pdfDoc.save();
        fs.writeFileSync(outputPath, pdfBytes);
        console.log(`✅ DOCX converted to PDF successfully (${pdfBytes.length} bytes)`);
        return true;
        
    } catch (error) {
        console.error('❌ Error converting DOCX to PDF:', error.message);
        return false;
    }
}

// Function to count PDF pages using multiple methods for better reliability
async function countPdfPages(pdfPath) {
    try {
        // Basic sanity checks to avoid passing non-PDFs to the parser
        const stats = fs.statSync(pdfPath);
        if (!stats || stats.size < 5) {
            throw new Error('PDF file is empty or too small');
        }

        const fd = fs.openSync(pdfPath, 'r');
        try {
            const headerBuffer = Buffer.alloc(5);
            fs.readSync(fd, headerBuffer, 0, 5, 0);
            const header = headerBuffer.toString();
            if (!header.startsWith('%PDF-')) {
                throw new Error('Invalid PDF structure');
            }
        } finally {
            fs.closeSync(fd);
        }

        // Method 1: Try pdf-parse first (best for text-based PDFs)
        try {
            const pdfParse = require('pdf-parse');
            const dataBuffer = fs.readFileSync(pdfPath);
            const data = await pdfParse(dataBuffer);
            console.log(`PDF parsed successfully with pdf-parse: ${data.numpages} pages`);
            return data.numpages;
        } catch (parseError) {
            console.warn('pdf-parse failed, trying pdf-lib method:', parseError.message);
        }

        // Method 2: Try pdf-lib for image-only or complex PDFs
        try {
            const { PDFDocument } = require('pdf-lib');
            const dataBuffer = fs.readFileSync(pdfPath);
            const pdfDoc = await PDFDocument.load(dataBuffer);
            const pageCount = pdfDoc.getPageCount();
            console.log(`PDF parsed successfully with pdf-lib: ${pageCount} pages`);
            return pageCount;
        } catch (libError) {
            console.warn('pdf-lib failed, trying alternative methods:', libError.message);
        }

        // Method 3: Try to extract page count from PDF metadata using basic parsing
        try {
            const dataBuffer = fs.readFileSync(pdfPath);
            const pdfContent = dataBuffer.toString('latin1');
            
            // Look for page count patterns in PDF content
            const pageCountPatterns = [
                /\/Count\s+(\d+)/g,
                /\/N\s+(\d+)/g,
                /\/Pages\s+(\d+)/g,
                /\/PageCount\s+(\d+)/g
            ];
            
            for (const pattern of pageCountPatterns) {
                const matches = pdfContent.match(pattern);
                if (matches && matches.length > 0) {
                    // Extract the highest number found (likely the page count)
                    const numbers = matches.map(match => {
                        const numMatch = match.match(/(\d+)/);
                        return numMatch ? parseInt(numMatch[1]) : 0;
                    });
                    const maxNumber = Math.max(...numbers);
                    if (maxNumber > 0 && maxNumber < 10000) { // Sanity check
                        console.log(`PDF page count extracted from metadata: ${maxNumber} pages`);
                        return maxNumber;
                    }
                }
            }
            
            // Method 4: Count page objects in PDF structure
            const pageObjectPattern = /\/Type\s*\/Page/g;
            const pageMatches = pdfContent.match(pageObjectPattern);
            if (pageMatches && pageMatches.length > 0) {
                const pageCount = pageMatches.length;
                console.log(`PDF page count from object count: ${pageCount} pages`);
                return pageCount;
            }
            
            throw new Error('Could not extract page count from PDF metadata');
            
        } catch (metadataError) {
            console.warn('Metadata extraction failed:', metadataError.message);
        }

        // Method 5: Enhanced size-based estimation for image-only PDFs
        const fileSizeKB = stats.size / 1024;
        const fileSizeMB = fileSizeKB / 1024;
        
        console.log(`Using enhanced size-based estimation for PDF: ${fileSizeKB.toFixed(2)} KB`);
        
        // More sophisticated estimation based on typical PDF sizes
        if (fileSizeKB < 10) {
            return 1; // Very small PDF, likely 1 page
        } else if (fileSizeKB < 100) {
            // Small PDFs: estimate based on typical single-page sizes
            if (fileSizeKB < 30) return 1;
            else if (fileSizeKB < 60) return 2;
            else return 3;
        } else if (fileSizeKB < 500) {
            // Medium PDFs: estimate based on typical multi-page sizes
            if (fileSizeKB < 200) return Math.max(2, Math.round(fileSizeKB / 50));
            else return Math.max(3, Math.round(fileSizeKB / 80));
        } else if (fileSizeMB < 5) {
            // Large PDFs: estimate based on typical document sizes
            return Math.max(5, Math.round(fileSizeMB * 2));
        } else {
            // Very large PDFs: conservative estimate
            return Math.max(10, Math.round(fileSizeMB * 1.5));
        }
        
    } catch (error) {
        console.error('Error counting PDF pages:', error);
        throw error;
    }
}

// Function to count DOCX pages by reading document properties
// DOCX files store page count in app.xml or core.xml
async function countDocxPagesWithMammoth(docxPath) {
    try {
        console.log('DOCX file detected - attempting to read page count from document properties...');
        
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(docxPath);
        
        // Try to read docProps/app.xml which contains page count
        try {
            const appXmlEntry = zip.getEntry('docProps/app.xml');
            if (appXmlEntry) {
                const appXml = zip.readAsText(appXmlEntry);
                // Look for <Pages> tag
                const pagesMatch = appXml.match(/<Pages>(\d+)<\/Pages>/);
                if (pagesMatch && pagesMatch[1]) {
                    const pageCount = parseInt(pagesMatch[1]);
                    console.log(`✅ Found page count in app.xml: ${pageCount} pages`);
                    return pageCount;
                }
            }
        } catch (e) {
            console.warn('Could not read app.xml:', e.message);
        }
        
        // Try to read docProps/core.xml
        try {
            const coreXmlEntry = zip.getEntry('docProps/core.xml');
            if (coreXmlEntry) {
                const coreXml = zip.readAsText(coreXmlEntry);
                // Some DOCX files store page count here
                const pagesMatch = coreXml.match(/<Pages>(\d+)<\/Pages>/);
                if (pagesMatch && pagesMatch[1]) {
                    const pageCount = parseInt(pagesMatch[1]);
                    console.log(`✅ Found page count in core.xml: ${pageCount} pages`);
                    return pageCount;
                }
            }
        } catch (e) {
            console.warn('Could not read core.xml:', e.message);
        }
        
        console.log('Page count not found in document properties, falling back to LibreOffice...');
        return null; // Fall back to LibreOffice conversion
        
    } catch (error) {
        console.warn('Error reading DOCX properties:', error.message);
        return null; // Fall back to LibreOffice
    }
}

// Function to get page count for any file type
async function getPageCount(filePath, fileType) {
    try {
        if (fileType === 'application/pdf' || filePath.toLowerCase().endsWith('.pdf')) {
            // Direct PDF page counting
            try {
                return await countPdfPages(filePath);
            } catch (pdfError) {
                console.warn('Failed to parse PDF, falling back to size-based estimation:', pdfError.message);
                const stats = fs.statSync(filePath);
                // Method 5: Enhanced size-based estimation for image-only PDFs
                const fileSizeKB = stats.size / 1024;
                const fileSizeMB = fileSizeKB / 1024;
                if (fileSizeKB < 5) {
                    return 1;
                } else if (fileSizeKB < 50) {
                    return Math.max(1, Math.round(fileSizeKB / 10));
                } else {
                    return Math.max(1, Math.round(fileSizeKB / 8));
                }
            }
        } else if (fileType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || 
                   filePath.toLowerCase().endsWith('.docx')) {
            // STRATEGY 1: Try fast mammoth extraction first (instant, works for all DOCX)
            console.log('DOCX detected - trying fast mammoth extraction first...');
            const mammothPageCount = await countDocxPagesWithMammoth(filePath);
            if (mammothPageCount !== null) {
                console.log(`✅ Mammoth succeeded: ${mammothPageCount} pages`);
                return mammothPageCount;
            }
            
            // STRATEGY 2: Convert DOCX to PDF using pure JavaScript (no LibreOffice needed)
            console.log('Mammoth failed, converting DOCX to PDF using pure JavaScript...');
            const pdfPath = path.join(
                path.dirname(filePath),
                `${path.basename(filePath)}_converted.pdf`
            );
            
            const conversionSuccess = await convertDocxToPdf(filePath, pdfPath);
            if (conversionSuccess) {
                try {
                    const pageCount = await countPdfPages(pdfPath);
                    console.log(`✅ Pure JS conversion succeeded: ${pageCount} pages`);
                    return pageCount;
                } catch (parseErr) {
                    console.warn('PDF parse failed after DOCX conversion; using estimation:', parseErr.message);
                } finally {
                    // Clean up the temporary PDF file
                    if (fs.existsSync(pdfPath)) {
                        fs.unlinkSync(pdfPath);
                    }
                }
            }
            
            // STRATEGY 3: Fallback to file size estimation
            console.log('Conversion failed, using file size estimation...');
            const stats = fs.statSync(filePath);
            const fileSizeKB = stats.size / 1024;
            const estimatedPages = fileSizeKB > 50 ? Math.max(2, Math.ceil(fileSizeKB / 25)) : 1;
            console.log(`⚠️ File size estimation: ${estimatedPages} pages (${fileSizeKB.toFixed(1)} KB)`);
            return estimatedPages;
        } else {
            // For other file types, use file size estimation
            const stats = fs.statSync(filePath);
            const fileSizeKB = stats.size / 1024;
            if (fileSizeKB < 5) {
                return 1;
            } else if (fileSizeKB < 50) {
                return Math.max(1, Math.round(fileSizeKB / 10));
            } else {
                return Math.max(1, Math.round(fileSizeKB / 8));
            }
        }
    } catch (error) {
        console.error('Error getting page count:', error);
        throw error;
    }
}

// API endpoint for file upload and page counting
app.post('/api/page-count', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const filePath = req.file.path;
        const fileType = req.file.mimetype;
        const fileName = req.file.originalname;

        console.log(`Processing file: ${fileName} (${fileType})`);

        const pageCount = await getPageCount(filePath, fileType);

        // Clean up the uploaded file
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }

        res.json({ 
            success: true, 
            fileName: fileName,
            pageCount: pageCount,
            fileType: fileType
        });

    } catch (error) {
        console.error('Error processing file:', error);
        
        // Clean up the uploaded file on error
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }

        res.status(500).json({ 
            error: 'Error processing file',
            details: error.message 
        });
    }
});

// Helpful GET to clarify usage
app.get('/api/print', (req, res) => {
    res.status(405).json({ error: 'Use POST /api/print with multipart/form-data to upload and print a file.' });
});

// Print endpoint for actual printing (POST)
app.post('/api/print', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        ensureDirectoryExists(SAVED_DIR);

        const filePath = req.file.path;
        const fileType = req.file.mimetype;
        const fileName = req.file.originalname;
        const { startPage, endPage, paperSize, colorMode, coinsInserted, change, sessionId } = req.body;
        
        // Check if session is allowed to proceed with payment
        if (sessionId) {
            if (!queueManager.canProceedToPayment(sessionId)) {
                return res.status(403).json({ 
                    error: 'Not your turn to pay. Please wait in queue.',
                    queueStatus: queueManager.getQueueStatus(sessionId)
                });
            }
        }

        console.log(`Printing file: ${fileName} (${fileType})`);
        console.log(`Pages: ${startPage}-${endPage}, Size: ${paperSize}, Color: ${colorMode}`);
        console.log(`Payment: ₱${coinsInserted} inserted, ₱${change} change`);
        console.log(`Payment values - coinsInserted: "${coinsInserted}" (type: ${typeof coinsInserted}), change: "${change}" (type: ${typeof change})`);
        console.log(`File path: ${filePath}`);
        console.log(`File exists: ${fs.existsSync(filePath)}`);
        console.log(`Page range values - startPage: "${startPage}" (type: ${typeof startPage}), endPage: "${endPage}" (type: ${typeof endPage})`);

        let printFilePath = filePath;
        let tempPdfPath = null;
        let tempCopiedPdfPath = null;
        let savedCopyPath = null;

        try {
            // Save a persistent copy for 30 minutes with a proper extension
            const originalExt = path.extname(fileName).toLowerCase();
            let fallbackExt = '';
            if (!originalExt) {
                if (fileType === 'application/pdf') fallbackExt = '.pdf';
                else if (fileType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') fallbackExt = '.docx';
            }
            savedCopyPath = buildSavedPath(fileName, fallbackExt);
            fs.copyFileSync(filePath, savedCopyPath);
            console.log('Saved persistent copy:', savedCopyPath);

            // Prefer printing from a path that has proper extension
            const isPdfUpload = fileType === 'application/pdf' || fileName.toLowerCase().endsWith('.pdf');
            if (isPdfUpload) {
                // If the saved copy has .pdf, print from it
                if (savedCopyPath.toLowerCase().endsWith('.pdf')) {
                    printFilePath = savedCopyPath;
                } else {
                    tempCopiedPdfPath = path.join('uploads', `${path.parse(fileName).name || 'upload'}_${Date.now()}.pdf`);
                    fs.copyFileSync(filePath, tempCopiedPdfPath);
                    printFilePath = tempCopiedPdfPath;
                    console.log('Copied uploaded PDF to .pdf path:', printFilePath);
                }
            }

            // Convert DOCX to PDF if needed for printing
            if (fileType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || 
                fileName.toLowerCase().endsWith('.docx')) {
                tempPdfPath = path.join('uploads', `temp_${Date.now()}.pdf`);
                const conversionSuccess = await convertDocxToPdf(filePath, tempPdfPath);
                if (conversionSuccess && fs.existsSync(tempPdfPath)) {
                    printFilePath = tempPdfPath;
                    console.log('DOCX converted to PDF for printing');
                } else {
                    throw new Error('Failed to convert DOCX to PDF');
                }
            }

            // Convert DOC to PDF if needed for printing
            if (fileType === 'application/msword' || 
                fileName.toLowerCase().endsWith('.doc')) {
                tempPdfPath = path.join('uploads', `temp_${Date.now()}.pdf`);
                const libreOfficeCmd = await resolveLibreOfficeCmd();
                if (!libreOfficeCmd) {
                    throw new Error('LibreOffice not available for DOC conversion');
                }
                const command = `"${libreOfficeCmd}" --headless --convert-to pdf --outdir "${path.dirname(tempPdfPath)}" "${filePath}"`;
                // Use exec with windowsHide option to prevent cmd prompt from showing on Windows
                await new Promise((resolve, reject) => {
                    exec(command, { windowsHide: true }, (error, stdout, stderr) => {
                        if (error) reject(error);
                        else resolve();
                    });
                });
                
                // LibreOffice creates the file with the same base name but .pdf extension
                const expectedPdfPath = path.join(
                    path.dirname(tempPdfPath),
                    `${path.basename(filePath, path.extname(filePath))}.pdf`
                );
                if (fs.existsSync(expectedPdfPath)) {
                    // Move to the desired output path
                    fs.renameSync(expectedPdfPath, tempPdfPath);
                    printFilePath = tempPdfPath;
                    console.log('DOC converted to PDF for printing');
                } else {
                    throw new Error('Failed to convert DOC to PDF');
                }
            }

            // Verify the file still exists before printing
            if (!fs.existsSync(printFilePath)) {
                throw new Error(`File not found for printing: ${printFilePath}`);
            }

            console.log(`Sending file to printer: ${printFilePath}`);
            console.log(`Original filename: ${req.file.originalname}`);
            console.log(`File extension from original name: ${path.extname(req.file.originalname)}`);

            // Send to printer with page range if specified
            // Always create page range object if both values are provided, even if they're the same
            const pageRange = (startPage && endPage) ? {
                startPage: parseInt(startPage),
                endPage: parseInt(endPage)
            } : null;
            
            console.log('Created page range object:', pageRange);
            
            // Get default printer from configuration
            const printerConfig = require('./printer_config');
            const defaultPrinter = printerConfig.DEFAULT_PRINTER;
            
            const printResult = await printFile(printFilePath, defaultPrinter, pageRange, paperSize, colorMode);
            console.log('Print result:', printResult);
            
            if (printResult.success) {
                // Record print transaction in database
                try {
                    const Database = require('./database');
                    const db = new Database();
                    const pagesPrinted = parseInt(endPage) - parseInt(startPage) + 1;
                    
                    // Load pricing configuration
                    const configPath = path.join(__dirname, 'pricing-config.json');
                    let pricingConfig;
                    try {
                        const configData = fs.readFileSync(configPath, 'utf8');
                        pricingConfig = JSON.parse(configData);
                    } catch (configError) {
                        console.error('Error loading pricing config, using defaults:', configError);
                        // Fallback to default pricing
                        pricingConfig = {
                            shortPaper: { grayscale: 3, colored: 5.4 },
                            longPaper: { grayscale: 5, colored: 9 }
                        };
                    }
                    
                    // Calculate total cost based on pricing configuration
                    let baseCost;
                    if (paperSize === 'long') {
                        baseCost = colorMode === 'colored' ? pricingConfig.longPaper.colored : pricingConfig.longPaper.grayscale;
                    } else {
                        baseCost = colorMode === 'colored' ? pricingConfig.shortPaper.colored : pricingConfig.shortPaper.grayscale;
                    }
                    const totalCost = Math.round(pagesPrinted * baseCost * 100) / 100; // Round to 2 decimal places
                    
                    console.log(`Recording transaction - Total Cost: ₱${totalCost}, Coins Inserted: ₱${coinsInserted}, Change: ₱${change}`);
                    console.log(`Parsed values - parseInt(coinsInserted): ${parseInt(coinsInserted)}, parseInt(change): ${parseInt(change)}`);
                    
                    await db.recordPrintTransaction(
                        fileName, pagesPrinted, paperSize, colorMode, 
                        totalCost, parseInt(coinsInserted), parseInt(change), 
                        `session_${Date.now()}`
                    );
                } catch (dbError) {
                    console.error('Error recording print transaction:', dbError);
                    // Don't fail the print request if database recording fails
                }
                console.log('Print transaction recorded successfully');
                
                // Complete the session in queue
                if (sessionId) {
                    queueManager.completeSession(sessionId);
                    console.log(`Session ${sessionId} completed and removed from queue`);
                }
                
                res.json({ 
                    success: true, 
                    message: 'File sent to printer successfully',
                    fileName: fileName,
                    pages: `${startPage}-${endPage}`,
                    paperSize: paperSize,
                    colorMode: colorMode,
                    print: {
                        method: printResult.method || null,
                        printer: printResult.printer || null,
                        jobId: printResult.jobId || null,
                        output: printResult.output || null,
                        errorOutput: printResult.errorOutput || null
                    },
                    saved: savedCopyPath ? {
                        file: path.basename(savedCopyPath),
                        url: `/uploads/saved/${encodeURIComponent(path.basename(savedCopyPath))}`,
                        localPath: path.resolve(savedCopyPath),
                        expiresInMinutes: Math.round(SAVED_TTL_MS / 60000)
                    } : null
                });
            } else {
                throw new Error(printResult.error || 'Printing failed');
            }

        } finally {
            // Clean up temporary files
            if (tempPdfPath && fs.existsSync(tempPdfPath)) {
                try { fs.unlinkSync(tempPdfPath); console.log('Cleaned up temporary PDF file'); } catch (cleanupError) { console.log('Error cleaning up temp PDF:', cleanupError.message); }
            }
            if (tempCopiedPdfPath && fs.existsSync(tempCopiedPdfPath)) {
                try { fs.unlinkSync(tempCopiedPdfPath); console.log('Cleaned up copied PDF file'); } catch (cleanupError) { console.log('Error cleaning up copied PDF:', cleanupError.message); }
            }
            // Remove the temporary multer upload (we already saved a persistent copy)
            if (req.file && fs.existsSync(req.file.path)) {
                try { fs.unlinkSync(req.file.path); } catch (_) {}
            }
        }

    } catch (error) {
        console.error('Error printing file:', error);
        // Clean up the uploaded file on error
        if (req.file && fs.existsSync(req.file.path)) {
            try {
                fs.unlinkSync(req.file.path);
                console.log('Cleaned up uploaded file on error');
            } catch (cleanupError) {
                console.log('Error cleaning up uploaded file:', cleanupError.message);
            }
        }
        res.status(500).json({ 
            error: 'Error printing file',
            details: error.message 
        });
    }
});

// List saved files (non-expired)
app.get('/api/saved-files', async (req, res) => {
    try {
        ensureDirectoryExists(SAVED_DIR);
        cleanupExpiredSavedFiles();
        const now = Date.now();
        const files = [];
        for (const name of fs.readdirSync(SAVED_DIR)) {
            const full = path.join(SAVED_DIR, name);
            try {
                const stat = fs.statSync(full);
                if (!stat.isFile()) continue;
                const age = now - stat.mtimeMs;
                if (age > SAVED_TTL_MS) continue; // skip expired
                files.push({
                    file: name,
                    size: stat.size,
                    createdAt: stat.mtimeMs,
                    expiresAt: stat.mtimeMs + SAVED_TTL_MS,
                    url: `/uploads/saved/${encodeURIComponent(name)}`
                });
            } catch (_) {}
        }
        res.json({ success: true, files });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Open a saved file in Windows Explorer (GET helper)
app.get('/api/open-saved', async (req, res) => {
    try {
        if (!IS_WINDOWS) {
            return res.status(400).json({ success: false, error: 'Not supported on this OS' });
        }

        const filename = req.query.filename;
        if (!filename) return res.status(400).json({ success: false, error: 'filename query is required' });
        const safe = path.basename(filename);
        const fullPath = path.join(SAVED_DIR, safe);
        if (!fs.existsSync(fullPath)) return res.status(404).json({ success: false, error: 'File not found' });
        if (isExpired(fullPath)) return res.status(410).json({ success: false, error: 'File expired' });
        const fullResolved = path.resolve(fullPath);
        const psCmd = `powershell -NoProfile -NonInteractive -Command Start-Process explorer.exe -ArgumentList '/select,"${fullResolved.replace(/"/g, '""')}"'`;
        await execAsync(psCmd);
        res.json({ success: true, opened: fullResolved, command: psCmd });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Open a saved file in Windows Explorer
app.post('/api/open-saved', express.json(), async (req, res) => {
    try {
        if (!IS_WINDOWS) {
            return res.status(400).json({ success: false, error: 'Not supported on this OS' });
        }

        const { filename } = req.body || {};
        if (!filename) return res.status(400).json({ success: false, error: 'filename is required' });
        const safe = path.basename(filename);
        const fullPath = path.join(SAVED_DIR, safe);
        if (!fs.existsSync(fullPath)) return res.status(404).json({ success: false, error: 'File not found' });
        if (isExpired(fullPath)) return res.status(410).json({ success: false, error: 'File expired' });
        // Open Explorer and select the file via PowerShell with robust quoting
        const fullResolved = path.resolve(fullPath);
        const psCmd = `powershell -NoProfile -NonInteractive -Command Start-Process explorer.exe -ArgumentList '/select,"${fullResolved.replace(/"/g, '""')}"'`;
        await execAsync(psCmd);
        res.json({ success: true, opened: fullResolved, command: psCmd });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Print a previously saved file by filename
app.post('/api/print-saved', express.json(), async (req, res) => {
    try {
        const { filename } = req.body || {};
        if (!filename) return res.status(400).json({ success: false, error: 'filename is required' });
        const safe = path.basename(filename);
        const fullPath = path.join(SAVED_DIR, safe);
        if (!fs.existsSync(fullPath)) return res.status(404).json({ success: false, error: 'File not found' });
        if (isExpired(fullPath)) return res.status(410).json({ success: false, error: 'File expired' });

        let printPath = fullPath;
        let tempPdfPath = null;
        const ext = path.extname(fullPath).toLowerCase();
        if (ext === '.docx') {
            tempPdfPath = path.join('uploads', `temp_${Date.now()}.pdf`);
            const conversionSuccess = await convertDocxToPdf(fullPath, tempPdfPath);
            if (!conversionSuccess) {
                return res.status(500).json({ success: false, error: 'Failed to convert DOCX to PDF' });
            }
            printPath = tempPdfPath;
        }

        // Get default printer from configuration
        const printerConfig = require('./printer_config');
        const defaultPrinter = printerConfig.DEFAULT_PRINTER;
        
        const result = await printFile(printPath, defaultPrinter, null, 'short', 'grayscale');

        if (tempPdfPath && fs.existsSync(tempPdfPath)) {
            try { fs.unlinkSync(tempPdfPath); } catch (_) {}
        }

        if (result.success) {
            res.json({ success: true, message: 'Saved file sent to printer', file: safe });
        } else {
            res.status(500).json({ success: false, error: result.error || 'Printing failed' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// PowerShell test endpoint
app.get('/api/test-powershell', async (req, res) => {
    try {
        if (!IS_WINDOWS) {
            return res.status(400).json({ success: false, error: 'Not supported on this OS' });
        }

        console.log('Testing PowerShell execution...');
        const result = await testPowerShell();
        
        if (result.success) {
            res.json({ 
                success: true, 
                message: 'PowerShell test successful',
                output: result.output
            });
        } else {
            res.status(500).json({ 
                success: false, 
                error: 'PowerShell test failed',
                details: result.error
            });
        }
        
    } catch (error) {
        console.error('PowerShell test error:', error);
        res.status(500).json({ error: 'PowerShell test failed', details: error.message });
    }
});

// Debug endpoint to test file uploads
app.post('/api/debug-upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        
        console.log('Debug upload - File received:');
        console.log('  Original name:', req.file.originalname);
        console.log('  MIME type:', req.file.mimetype);
        console.log('  Size:', req.file.size);
        console.log('  Path:', req.file.path);
        console.log('  File exists:', fs.existsSync(req.file.path));
        
        // Don't delete the file for debugging
        res.json({ 
            success: true, 
            message: 'File uploaded successfully',
            file: {
                originalname: req.file.originalname,
                mimetype: req.file.mimetype,
                size: req.file.size,
                path: req.file.path,
                exists: fs.existsSync(req.file.path)
            }
        });
        
    } catch (error) {
        console.error('Debug upload error:', error);
        res.status(500).json({ error: 'Debug upload failed', details: error.message });
    }
});

// Test print endpoint - creates a simple test document
app.post('/api/test-print', async (req, res) => {
    try {
        // Create a simple test HTML file (better for Windows printing)
        const testFilePath = path.join('uploads', `test_print_${Date.now()}.html`);
        const testContent = `<!DOCTYPE html>
<html>
<head>
    <title>Test Print Document</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 40px; }
        .header { text-align: center; border-bottom: 2px solid #333; padding-bottom: 20px; margin-bottom: 30px; }
        .content { line-height: 1.6; }
        .footer { margin-top: 40px; text-align: center; font-size: 12px; color: #666; }
    </style>
</head>
<body>
    <div class="header">
        <h1>🖨️ Test Print Document</h1>
        <h2>Epson L120 Series Printer Test</h2>
    </div>
    
    <div class="content">
        <p><strong>Generated:</strong> ${new Date().toLocaleString()}</p>
        <p>This is a test document to verify that your Piso Printer application is working correctly.</p>
        
        <h3>If you can see this printed:</h3>
        <ul>
            <li>✅ Your printer connection is working</li>
            <li>✅ The printing system is functional</li>
            <li>✅ Your Epson L120 is ready for real documents</li>
        </ul>
        
        <p><strong>Printer:</strong> EPSON L120 Series</p>
        <p><strong>Test Time:</strong> ${new Date().toLocaleTimeString()}</p>
    </div>
    
    <div class="footer">
        <p>Piso Printer Test Document - Page 1 of 1</p>
    </div>
</body>
</html>`;

        fs.writeFileSync(testFilePath, testContent);
        
        console.log('Created test HTML file:', testFilePath);
        
        // Get default printer from configuration
        const printerConfig = require('./printer_config');
        const defaultPrinter = printerConfig.DEFAULT_PRINTER;
        
        // Try to print the test file
        const printResult = await printFile(testFilePath, defaultPrinter, null, 'short', 'grayscale');
        
        if (printResult.success) {
            res.json({ 
                success: true, 
                message: 'Test print sent to printer',
                testFile: testFilePath
            });
        } else {
            throw new Error(printResult.error);
        }
        
    } catch (error) {
        console.error('Test print error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Test page range printing endpoint
app.post('/api/test-page-range', async (req, res) => {
    try {
        const { startPage, endPage } = req.body;
        console.log(`Testing page range printing: ${startPage}-${endPage}`);
        
        // Create a multi-page test HTML file
        const testFilePath = path.join('uploads', `test_page_range_${Date.now()}.html`);
        const testContent = `<!DOCTYPE html>
<html>
<head>
    <title>Page Range Test Document</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 40px; }
        .page { page-break-after: always; min-height: 800px; }
        .page:last-child { page-break-after: avoid; }
        .header { text-align: center; border-bottom: 2px solid #333; padding-bottom: 20px; margin-bottom: 30px; }
        .content { line-height: 1.6; }
        .footer { margin-top: 40px; text-align: center; font-size: 12px; color: #666; }
    </style>
</head>
<body>
    <div class="page">
        <div class="header">
            <h1>🖨️ Page Range Test Document</h1>
            <h2>Page 1 of 3</h2>
        </div>
        <div class="content">
            <p><strong>Generated:</strong> ${new Date().toLocaleString()}</p>
            <p>This is page 1 of a 3-page test document.</p>
            <p>Testing page range printing functionality.</p>
        </div>
        <div class="footer">
            <p>Page 1 of 3</p>
        </div>
    </div>
    
    <div class="page">
        <div class="header">
            <h1>🖨️ Page Range Test Document</h1>
            <h2>Page 2 of 3</h2>
        </div>
        <div class="content">
            <p>This is page 2 of the test document.</p>
            <p>If you can see this printed, page range extraction is working!</p>
        </div>
        <div class="footer">
            <p>Page 2 of 3</p>
        </div>
    </div>
    
    <div class="page">
        <div class="header">
            <h1>🖨️ Page Range Test Document</h1>
            <h2>Page 3 of 3</h2>
        </div>
        <div class="content">
            <p>This is the final page of the test document.</p>
            <p>Page range printing test completed successfully!</p>
        </div>
        <div class="footer">
            <p>Page 3 of 3</p>
        </div>
    </div>
</body>
</html>`;

        fs.writeFileSync(testFilePath, testContent);
        
        console.log('Created multi-page test HTML file:', testFilePath);
        
        // Get default printer from configuration
        const printerConfig = require('./printer_config');
        const defaultPrinter = printerConfig.DEFAULT_PRINTER;
        
        // Test printing with page range
        const pageRange = { startPage: parseInt(startPage), endPage: parseInt(endPage) };
        const printResult = await printFile(testFilePath, defaultPrinter, pageRange, 'short', 'grayscale');
        
        if (printResult.success) {
            res.json({ 
                success: true, 
                message: `Page range ${startPage}-${endPage} sent to printer`,
                testFile: testFilePath,
                pageRange: pageRange
            });
        } else {
            throw new Error(printResult.error);
        }
        
    } catch (error) {
        console.error('Test page range error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Test color mode printing endpoint
app.post('/api/test-color-mode', async (req, res) => {
    try {
        const { colorMode } = req.body;
        console.log(`Testing color mode printing: ${colorMode}`);
        
        // Create a test HTML file with color elements to test color vs grayscale
        const testFilePath = path.join('uploads', `test_color_mode_${Date.now()}.html`);
        const testContent = `<!DOCTYPE html>
<html>
<head>
    <title>Color Mode Test Document</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 40px; }
        .header { text-align: center; border-bottom: 2px solid #333; padding-bottom: 20px; margin-bottom: 30px; }
        .content { line-height: 1.6; }
        .color-test { 
            background-color: #ff0000; 
            color: white; 
            padding: 10px; 
            margin: 10px 0; 
            border: 3px solid #00ff00;
        }
        .blue-text { color: #0000ff; font-weight: bold; }
        .green-bg { background-color: #00ff00; padding: 5px; }
        .footer { margin-top: 40px; text-align: center; font-size: 12px; color: #666; }
    </style>
</head>
<body>
    <div class="header">
        <h1>🎨 Color Mode Test Document</h1>
        <h2>Testing: ${colorMode.toUpperCase()} Mode</h2>
    </div>
    
    <div class="content">
        <p><strong>Generated:</strong> ${new Date().toLocaleString()}</p>
        <p>This document tests ${colorMode} printing mode.</p>
        
        <div class="color-test">
            <h3>🔴 Red Background with Green Border</h3>
            <p>This should appear as <span class="blue-text">blue text</span> on a red background with a green border.</p>
        </div>
        
        <p>If you're in <span class="green-bg">grayscale mode</span>, this should appear in shades of gray.</p>
        <p>If you're in <span style="color: #ff6600;">colored mode</span>, you should see the actual colors.</p>
        
        <h3>Color Test Elements:</h3>
        <ul>
            <li style="color: #ff0000;">🔴 Red text</li>
            <li style="color: #00ff00;">🟢 Green text</li>
            <li style="color: #0000ff;">🔵 Blue text</li>
            <li style="color: #ffff00; background-color: #000000;">🟡 Yellow text on black</li>
        </ul>
        
        <p><strong>Printer:</strong> EPSON L120 Series</p>
        <p><strong>Test Time:</strong> ${new Date().toLocaleTimeString()}</p>
        <p><strong>Mode:</strong> ${colorMode}</p>
    </div>
    
    <div class="footer">
        <p>Color Mode Test Document - ${colorMode.toUpperCase()} Mode</p>
    </div>
</body>
</html>`;

        fs.writeFileSync(testFilePath, testContent);
        
        console.log('Created color mode test HTML file:', testFilePath);
        
        // Get default printer from configuration
        const printerConfig = require('./printer_config');
        const defaultPrinter = printerConfig.DEFAULT_PRINTER;
        
        // Test printing with specified color mode
        const printResult = await printFile(testFilePath, defaultPrinter, null, 'short', colorMode);
        
        if (printResult.success) {
            res.json({ 
                success: true, 
                message: `Color mode test (${colorMode}) sent to printer`,
                testFile: testFilePath,
                colorMode: colorMode
            });
        } else {
            throw new Error(printResult.error);
        }
        
    } catch (error) {
        console.error('Test color mode error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Printer test endpoint
app.get('/api/test-printer', async (req, res) => {
    try {
        const result = await testPrinter();
        res.json(result);
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Printer status endpoint
app.get('/api/printers', async (req, res) => {
    try {
        const printers = await getPrinters();
        res.json(printers);
    } catch (error) {
        console.error('Error getting printers:', error);
        res.status(500).json({ success: false, error: 'Failed to get printers' });
    }
});

// Detailed printer status endpoint
app.get('/api/printer-status/:printerName?', async (req, res) => {
    try {
        const printerName = req.params.printerName || 'EPSON L120 Series';
        const result = await getDetailedPrinterStatus(printerName);
        res.json(result);
    } catch (error) {
        console.error('Error getting detailed printer status:', error);
        res.status(500).json({ success: false, error: 'Failed to get detailed printer status' });
    }
});

// Printer readiness check endpoint
app.get('/api/printer-ready/:printerName?', async (req, res) => {
    try {
        const printerName = req.params.printerName || 'EPSON L120 Series';
        const result = await isPrinterReady(printerName);
        res.json(result);
    } catch (error) {
        console.error('Error checking printer readiness:', error);
        res.status(500).json({ success: false, error: 'Failed to check printer readiness' });
    }
});

// Debug endpoint to check printer properties
app.get('/api/printer-properties/:printerName?', async (req, res) => {
    try {
        if (!IS_WINDOWS) {
            return res.status(400).json({ success: false, error: 'Not supported on this OS' });
        }

        const printerName = req.params.printerName || 'EPSON L120 Series';
        const command = `powershell -Command "Get-PrinterProperty -PrinterName '${printerName}' | Select-Object Name, Value | ConvertTo-Json"`;
        const result = await execAsync(command);
        
        let properties = [];
        if (result.stdout) {
            try {
                const parsed = JSON.parse(result.stdout);
                properties = Array.isArray(parsed) ? parsed : [parsed];
            } catch (parseError) {
                console.warn('Could not parse printer properties JSON:', parseError);
                properties = [];
            }
        }

        res.json({
            success: true,
            printer: printerName,
            properties: properties
        });
    } catch (error) {
        console.error('Error getting printer properties:', error);
        res.status(500).json({ success: false, error: 'Failed to get printer properties' });
    }
});

// Enhanced printer properties endpoint with detailed color mode testing
app.get('/api/printer-color-test/:printerName?', async (req, res) => {
    try {
        if (!IS_WINDOWS) {
            return res.status(400).json({ success: false, error: 'Not supported on this OS' });
        }

        const printerName = req.params.printerName || 'EPSON L120 Series';
        
        // Test different color mode settings to see what works
        const testCommands = [
            `powershell -Command "Get-PrinterProperty -PrinterName '${printerName}' -PropertyName 'ColorMode' | ConvertTo-Json"`,
            `powershell -Command "Get-PrinterProperty -PrinterName '${printerName}' -PropertyName 'Color' | ConvertTo-Json"`,
            `powershell -Command "Get-PrinterProperty -PrinterName '${printerName}' -PropertyName 'PrintInGrayscale' | ConvertTo-Json"`,
            `powershell -Command "Get-PrinterProperty -PrinterName '${printerName}' -PropertyName 'Grayscale' | ConvertTo-Json"`,
            `powershell -Command "Get-PrinterProperty -PrinterName '${printerName}' -PropertyName 'Monochrome' | ConvertTo-Json"`
        ];
        
        const results = {};
        
        for (let i = 0; i < testCommands.length; i++) {
            try {
                const result = await execAsync(testCommands[i]);
                if (result.stdout) {
                    try {
                        const parsed = JSON.parse(result.stdout);
                        results[`test_${i}`] = { success: true, data: parsed };
                    } catch (parseError) {
                        results[`test_${i}`] = { success: false, error: 'Parse error', raw: result.stdout };
                    }
                } else {
                    results[`test_${i}`] = { success: false, error: 'No output' };
                }
            } catch (error) {
                results[`test_${i}`] = { success: false, error: error.message };
            }
        }
        
        // Also try to get all available properties
        try {
            const allPropsCommand = `powershell -Command "Get-PrinterProperty -PrinterName '${printerName}' | Select-Object Name, Value | ConvertTo-Json"`;
            const allPropsResult = await execAsync(allPropsCommand);
            if (allPropsResult.stdout) {
                try {
                    const parsed = JSON.parse(allPropsResult.stdout);
                    results.allProperties = { success: true, data: parsed };
                } catch (parseError) {
                    results.allProperties = { success: false, error: 'Parse error', raw: allPropsResult.stdout };
                }
            }
        } catch (error) {
            results.allProperties = { success: false, error: error.message };
        }

        res.json({
            success: true,
            printer: printerName,
            colorModeTests: results,
            message: 'Color mode property tests completed'
        });
    } catch (error) {
        console.error('Error testing printer color properties:', error);
        res.status(500).json({ success: false, error: 'Failed to test printer color properties' });
    }
});

// Admin Authentication Middleware
function requireAdminAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'No token provided' });
    }
    
    const token = authHeader.substring(7);
    
    // Token validation using config
    const adminConfig = require('./admin_config');
    if (token === adminConfig.ADMIN_TOKEN) {
        next();
    } else {
        res.status(401).json({ success: false, error: 'Invalid token' });
    }
}

// Role-based Authorization Middleware
function requireSuperAdminAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'No token provided' });
    }
    
    const token = authHeader.substring(7);
    
    // Token validation using config
    const adminConfig = require('./admin_config');
    if (token === adminConfig.ADMIN_TOKEN) {
        // For now, we'll use the same token for both roles
        // In production, you'd want to store user role in the token or session
        next();
    } else {
        res.status(401).json({ success: false, error: 'Invalid token' });
    }
}

// Admin Login Endpoint
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    const adminConfig = require('./admin_config');
    
    // Find user in config
    const user = Object.values(adminConfig.USERS).find(u => 
        u.username === username && u.password === password
    );
    
    if (user) {
        res.json({
            success: true,
            token: adminConfig.ADMIN_TOKEN,
            username: username,
            role: user.role,
            permissions: user.permissions,
            message: 'Login successful'
        });
    } else {
        res.status(401).json({
            success: false,
            error: 'Invalid username or password'
        });
    }
});

// Admin Token Verification Endpoint
app.get('/api/admin/verify-token', requireAdminAuth, (req, res) => {
    res.json({ success: true, message: 'Token valid' });
});

// Get User Permissions Endpoint
app.get('/api/admin/permissions', requireAdminAuth, (req, res) => {
    const adminConfig = require('./admin_config');
    const username = req.headers['x-username']; // We'll pass this from frontend
    
    // Find user permissions
    const user = Object.values(adminConfig.USERS).find(u => u.username === username);
    
    if (user) {
        res.json({
            success: true,
            role: user.role,
            permissions: user.permissions
        });
    } else {
        res.status(404).json({
            success: false,
            error: 'User not found'
        });
    }
});

// Admin Dashboard API Endpoints (Protected)
app.get('/api/admin/daily-summary', requireAdminAuth, async (req, res) => {
    try {
        const { dateFrom, dateTo } = req.query;
        const fromDate = dateFrom || new Date().toISOString().split('T')[0];
        const toDate = dateTo || new Date().toISOString().split('T')[0];
        
        const Database = require('./database');
        const db = new Database();
        
        const summary = await db.getDailySummaryRange(fromDate, toDate);
        res.json({ success: true, summary });
    } catch (error) {
        console.error('Error getting daily summary:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/admin/daily-coins', requireAdminAuth, async (req, res) => {
    try {
        const { dateFrom, dateTo } = req.query;
        const fromDate = dateFrom || new Date().toISOString().split('T')[0];
        const toDate = dateTo || new Date().toISOString().split('T')[0];
        
        const Database = require('./database');
        const db = new Database();
        
        const coins = await db.getDailyCoinsRange(fromDate, toDate);
        res.json({ success: true, coins });
    } catch (error) {
        console.error('Error getting daily coins:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/admin/anomaly-score', requireAdminAuth, async (req, res) => {
    try {
        const { dateFrom, dateTo } = req.query;
        const fromDate = dateFrom || new Date().toISOString().split('T')[0];
        const toDate = dateTo || new Date().toISOString().split('T')[0];
        
        const Database = require('./database');
        const db = new Database();
        
        const score = await db.calculateAnomalyScoreRange(fromDate, toDate);
        res.json({ success: true, anomaly_score: score });
    } catch (error) {
        console.error('Error getting anomaly score:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/check-anomalies', requireAdminAuth, async (req, res) => {
    try {
        const Database = require('./database');
        const db = new Database();
        
        const anomalies = await db.checkForAnomalies();
        res.json({ success: true, anomalies });
    } catch (error) {
        console.error('Error checking anomalies:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Database cleanup endpoints
app.get('/api/admin/database-stats', requireAdminAuth, async (req, res) => {
    try {
        const Database = require('./database');
        const db = new Database();
        
        const stats = await db.getTableStats();
        res.json({ success: true, stats });
    } catch (error) {
        console.error('Error getting database stats:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/cleanup', requireAdminAuth, async (req, res) => {
    try {
        const { type, days } = req.body;
        
        if (!type) {
            return res.status(400).json({ 
                success: false, 
                error: 'Cleanup type is required' 
            });
        }
        
        const Database = require('./database');
        const db = new Database();
        
        let message = '';
        
        switch (type) {
            case 'all':
                await db.clearAllData();
                message = 'All data cleared successfully';
                break;
            case 'old':
                const daysOld = days || 30;
                await db.clearOldData(daysOld);
                message = `Data older than ${daysOld} days cleared successfully`;
                break;
            case 'coins':
                await db.clearDailyCoins();
                message = 'Daily coins data cleared successfully';
                break;
            case 'summaries':
                await db.clearDailySummaries();
                message = 'Daily summaries data cleared successfully';
                break;
            case 'transactions':
                await db.clearPrintTransactions();
                message = 'Print transactions data cleared successfully';
                break;
            case 'anomalies':
                await db.clearAnomalies();
                message = 'Anomalies data cleared successfully';
                break;
            case 'reset-counters':
                await db.resetCounters();
                message = 'Auto-increment counters reset successfully';
                break;
            default:
                return res.status(400).json({ 
                    success: false, 
                    error: 'Invalid cleanup type' 
                });
        }
        
        res.json({ success: true, message });
    } catch (error) {
        console.error('Error during cleanup:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Manual Coin Entry API endpoint
app.post('/api/admin/manual-coin-entry', requireAdminAuth, async (req, res) => {
    try {
        const { coinType, coinValue, coinCount, coinDate, sessionId } = req.body;
        
        if (!coinType || !coinValue || !coinCount || coinCount < 1) {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid coin data provided' 
            });
        }
        
        const Database = require('./database');
        const db = new Database();
        
        const targetDate = coinDate || new Date().toISOString().split('T')[0];
        let successCount = 0;
        
        // Add multiple coins
        for (let i = 0; i < coinCount; i++) {
            try {
                await db.recordCoin(coinValue, coinType, sessionId);
                successCount++;
            } catch (error) {
                console.error(`Error recording coin ${i + 1}:`, error);
            }
        }
        
        db.close();
        
        if (successCount === coinCount) {
            res.json({ 
                success: true, 
                message: `Successfully recorded ${successCount} coins`,
                coinsAdded: successCount,
                totalValue: coinValue * successCount
            });
        } else {
            res.json({ 
                success: false, 
                error: `Only ${successCount} out of ${coinCount} coins were recorded`,
                coinsAdded: successCount,
                totalValue: coinValue * successCount
            });
        }
        
    } catch (error) {
        console.error('Error in manual coin entry:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Recalculate Transaction Costs API endpoint
app.post('/api/admin/recalculate-transaction-costs', requireAdminAuth, async (req, res) => {
    try {
        const { scope } = req.body; // 'all' or 'today'
        
        const Database = require('./database');
        const db = new Database();
        
        // Load current pricing configuration
        const configPath = path.join(__dirname, 'pricing-config.json');
        let pricingConfig;
        try {
            const configData = fs.readFileSync(configPath, 'utf8');
            pricingConfig = JSON.parse(configData);
        } catch (configError) {
            return res.status(500).json({ 
                success: false, 
                error: 'Could not load pricing configuration' 
            });
        }
        
        // Build query based on scope
        let query, params;
        if (scope === 'today') {
            const today = new Date().toISOString().split('T')[0];
            query = 'SELECT * FROM print_transactions WHERE date = ? ORDER BY timestamp ASC';
            params = [today];
        } else {
            query = 'SELECT * FROM print_transactions ORDER BY timestamp ASC';
            params = [];
        }
        
        // Get all transactions to recalculate
        const transactions = await new Promise((resolve, reject) => {
            db.db.all(query, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
        
        let updatedCount = 0;
        let totalCostDifference = 0;
        const updates = [];
        
        // Recalculate each transaction
        for (const transaction of transactions) {
            // Calculate new cost based on current pricing
            let baseCost;
            if (transaction.paper_size === 'long') {
                baseCost = transaction.color_mode === 'colored' ? 
                    pricingConfig.longPaper.colored : pricingConfig.longPaper.grayscale;
            } else {
                baseCost = transaction.color_mode === 'colored' ? 
                    pricingConfig.shortPaper.colored : pricingConfig.shortPaper.grayscale;
            }
            
            const newTotalCost = Math.round(transaction.pages_printed * baseCost * 100) / 100;
            const costDifference = newTotalCost - transaction.total_cost;
            
            if (Math.abs(costDifference) > 0.01) { // Only update if there's a meaningful difference
                updates.push({
                    id: transaction.id,
                    oldCost: transaction.total_cost,
                    newCost: newTotalCost,
                    costDifference: costDifference
                });
                
                totalCostDifference += costDifference;
            }
        }
        
        // Apply updates to database
        for (const update of updates) {
            await new Promise((resolve, reject) => {
                db.db.run(
                    'UPDATE print_transactions SET total_cost = ? WHERE id = ?',
                    [update.newCost, update.id],
                    function(err) {
                        if (err) reject(err);
                        else {
                            console.log(`Updated transaction ${update.id}: ₱${update.oldCost} → ₱${update.newCost}`);
                            resolve();
                        }
                    }
                );
            });
            updatedCount++;
        }
        
        db.close();
        
        res.json({ 
            success: true, 
            message: `Successfully recalculated ${updatedCount} transaction costs`,
            updatedCount,
            totalCostDifference,
            scope: scope || 'all'
        });
        
    } catch (error) {
        console.error('Error recalculating transaction costs:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Sync Coin Data API endpoint
app.post('/api/admin/sync-coin-data', requireAdminAuth, async (req, res) => {
    try {
        const { scope } = req.body; // 'today' or 'all'
        
        const Database = require('./database');
        const db = new Database();
        
        // Build query based on scope
        let query, params;
        if (scope === 'today') {
            const today = new Date().toISOString().split('T')[0];
            query = 'SELECT * FROM print_transactions WHERE date = ? ORDER BY timestamp ASC';
            params = [today];
        } else {
            query = 'SELECT * FROM print_transactions ORDER BY timestamp ASC';
            params = [];
        }
        
        // Get all transactions to sync with
        const transactions = await new Promise((resolve, reject) => {
            db.db.all(query, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
        
        // Get existing coin records for the same date(s)
        const existingCoins = await new Promise((resolve, reject) => {
            let coinQuery, coinParams;
            if (scope === 'today') {
                const today = new Date().toISOString().split('T')[0];
                coinQuery = 'SELECT * FROM daily_coins WHERE date = ?';
                coinParams = [today];
            } else {
                coinQuery = 'SELECT * FROM daily_coins';
                coinParams = [];
            }
            
            db.db.all(coinQuery, coinParams, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
        
        let coinsCreated = 0;
        let coinsFixed = 0;
        const processedTransactions = new Set();
        
        // Process each transaction
        for (const transaction of transactions) {
            if (processedTransactions.has(transaction.id)) continue;
            
            const coinsUsed = transaction.coins_used || 0;
            if (coinsUsed <= 0) continue;
            
            // Break down the payment into individual coins
            const coinBreakdown = breakDownPayment(coinsUsed);
            
            // Create coin records for this transaction
            for (const [coinType, count] of Object.entries(coinBreakdown)) {
                if (count > 0) {
                    const coinValue = parseInt(coinType);
                    const totalValue = coinValue * count;
                    
                    // Check if we already have enough coins of this type
                    const existingCount = existingCoins
                        .filter(coin => coin.coin_type === coinType && coin.date === transaction.date)
                        .reduce((sum, coin) => sum + (coin.coin_value / coinValue), 0);
                    
                    const needed = Math.max(0, count - existingCount);
                    
                    if (needed > 0) {
                        // Create missing coins
                        for (let i = 0; i < needed; i++) {
                            await db.recordCoin(coinValue, coinType, transaction.session_id);
                            coinsCreated++;
                        }
                    }
                }
            }
            
            processedTransactions.add(transaction.id);
        }
        
        // Fix incorrect coin records (like ₱9 instead of ₱1)
        const incorrectCoins = existingCoins.filter(coin => {
            const expectedValue = parseInt(coin.coin_type);
            return coin.coin_value !== expectedValue;
        });
        
        for (const incorrectCoin of incorrectCoins) {
            // Delete the incorrect record
            await new Promise((resolve, reject) => {
                db.db.run('DELETE FROM daily_coins WHERE id = ?', [incorrectCoin.id], (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
            
            // Create correct records
            const correctValue = parseInt(incorrectCoin.coin_type);
            const correctCount = Math.floor(incorrectCoin.coin_value / correctValue);
            
            for (let i = 0; i < correctCount; i++) {
                await db.recordCoin(correctValue, incorrectCoin.coin_type, incorrectCoin.session_id);
            }
            
            coinsFixed++;
        }
        
        // Calculate final total value
        const finalCoins = await new Promise((resolve, reject) => {
            let finalQuery, finalParams;
            if (scope === 'today') {
                const today = new Date().toISOString().split('T')[0];
                finalQuery = 'SELECT * FROM daily_coins WHERE date = ?';
                finalParams = [today];
            } else {
                finalQuery = 'SELECT * FROM daily_coins';
                finalParams = [];
            }
            
            db.db.all(finalQuery, finalParams, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
        
        const totalValue = finalCoins.reduce((sum, coin) => sum + coin.coin_value, 0);
        
        db.close();
        
        res.json({ 
            success: true, 
            message: `Successfully synced coin data`,
            coinsCreated,
            coinsFixed,
            totalValue,
            scope: scope || 'all'
        });
        
    } catch (error) {
        console.error('Error syncing coin data:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Helper function to break down payment into coins
function breakDownPayment(amount) {
    const coins = {};
    const denominations = [20, 10, 5, 1];
    
    let remaining = amount;
    
    for (const denomination of denominations) {
        const count = Math.floor(remaining / denomination);
        if (count > 0) {
            coins[denomination] = count;
            remaining -= count * denomination;
        }
    }
    
    return coins;
}

// Recent Coins API endpoint
app.get('/api/admin/recent-coins', requireAdminAuth, async (req, res) => {
    try {
        const Database = require('./database');
        const db = new Database();
        
        // Get recent coins (last 20 entries)
        const coins = await new Promise((resolve, reject) => {
            db.db.all(
                'SELECT * FROM daily_coins ORDER BY timestamp DESC LIMIT 20',
                [],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                }
            );
        });
        
        db.close();
        
        res.json({ success: true, coins });
        
    } catch (error) {
        console.error('Error getting recent coins:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Sync Data API endpoint
app.post('/api/admin/sync-data', requireAdminAuth, async (req, res) => {
    try {
        const Database = require('./database');
        const db = new Database();
        
        // Get all unique dates from daily_coins table
        const dates = await db.getAllCoinDates();
        
        let syncedCount = 0;
        
        for (const date of dates) {
            // Get coin data for this date
            const coins = await db.getDailyCoins(date);
            
            // Calculate totals
            let totalCoins = 0;
            let totalValue = 0;
            let coin1Count = 0;
            let coin5Count = 0;
            let coin10Count = 0;
            let coin20Count = 0;
            
            coins.forEach(coin => {
                totalCoins += coin.count || 0;
                totalValue += coin.total_value || 0;
                
                switch(coin.coin_type) {
                    case '1':
                        coin1Count = coin.count || 0;
                        break;
                    case '5':
                        coin5Count = coin.count || 0;
                        break;
                    case '10':
                        coin10Count = coin.count || 0;
                        break;
                    case '20':
                        coin20Count = coin.count || 0;
                        break;
                }
            });
            
            // Get transaction count for this date
            const transactions = await db.getPrintTransactionsByDate(date);
            const transactionCount = transactions.length;
            
            // Calculate average transaction value
            const avgTransactionValue = transactionCount > 0 ? totalValue / transactionCount : 0;
            
            // Update or insert daily summary
            await db.updateDailySummary(date, {
                total_coins: totalCoins,
                total_value: totalValue,
                coin_1_count: coin1Count,
                coin_5_count: coin5Count,
                coin_10_count: coin10Count,
                coin_20_count: coin20Count,
                transaction_count: transactionCount,
                avg_transaction_value: avgTransactionValue
            });
            
            syncedCount++;
        }
        
        res.json({ 
            success: true, 
            message: `Successfully synced ${syncedCount} daily summaries from coin data` 
        });
    } catch (error) {
        console.error('Error syncing data:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Settings API endpoints
app.post('/api/admin/update-credentials', requireAdminAuth, async (req, res) => {
    try {
        const { currentUsername, currentPassword, newUsername, newPassword } = req.body;
        const adminConfig = require('./admin_config');
        
        // Verify current credentials
        if (currentUsername !== adminConfig.ADMIN_USERNAME || currentPassword !== adminConfig.ADMIN_PASSWORD) {
            return res.status(401).json({ success: false, error: 'Current credentials are incorrect' });
        }
        
        // Update credentials in config file
        const fs = require('fs');
        const configPath = './admin_config.js';
        let configContent = fs.readFileSync(configPath, 'utf8');
        
        // Update username
        configContent = configContent.replace(
            /ADMIN_USERNAME:\s*['"`][^'"`]*['"`]/,
            `ADMIN_USERNAME: '${newUsername}'`
        );
        
        // Update password
        configContent = configContent.replace(
            /ADMIN_PASSWORD:\s*['"`][^'"`]*['"`]/,
            `ADMIN_PASSWORD: '${newPassword}'`
        );
        
        // Update token
        configContent = configContent.replace(
            /ADMIN_TOKEN:\s*['"`][^'"`]*['"`]/,
            `ADMIN_TOKEN: '${newPassword}'`
        );
        
        // Write updated config
        fs.writeFileSync(configPath, configContent);
        
        res.json({ success: true, message: 'Credentials updated successfully' });
    } catch (error) {
        console.error('Error updating credentials:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/update-security', requireAdminAuth, async (req, res) => {
    try {
        const { sessionTimeout, maxLoginAttempts, lockoutDuration } = req.body;
        
        // Update security settings in config file
        const fs = require('fs');
        const configPath = './admin_config.js';
        let configContent = fs.readFileSync(configPath, 'utf8');
        
        // Update session timeout
        configContent = configContent.replace(
            /SESSION_TIMEOUT:\s*\d+/,
            `SESSION_TIMEOUT: ${sessionTimeout * 60 * 60 * 1000}`
        );
        
        // Update max login attempts
        configContent = configContent.replace(
            /MAX_LOGIN_ATTEMPTS:\s*\d+/,
            `MAX_LOGIN_ATTEMPTS: ${maxLoginAttempts}`
        );
        
        // Update lockout duration
        configContent = configContent.replace(
            /LOCKOUT_DURATION:\s*\d+/,
            `LOCKOUT_DURATION: ${lockoutDuration * 60 * 1000}`
        );
        
        // Write updated config
        fs.writeFileSync(configPath, configContent);
        
        res.json({ success: true, message: 'Security settings updated successfully' });
    } catch (error) {
        console.error('Error updating security settings:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/admin/system-info', requireAdminAuth, async (req, res) => {
    try {
        const adminConfig = require('./admin_config');
        const fs = require('fs');
        const path = require('path');
        
        // Get database size
        const dbPath = path.join(__dirname, 'db.sqlite');
        let dbSize = '0 KB';
        if (fs.existsSync(dbPath)) {
            const stats = fs.statSync(dbPath);
            dbSize = `${(stats.size / 1024).toFixed(1)} KB`;
        }
        
        // Get server uptime
        const uptime = process.uptime();
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        const uptimeStr = `${hours}h ${minutes}m`;
        
        // Get last login time
        const lastLogin = new Date().toISOString();
        
        res.json({
            success: true,
            info: {
                currentUsername: adminConfig.ADMIN_USERNAME,
                dbSize: dbSize,
                uptime: uptimeStr,
                lastLogin: lastLogin
            }
        });
    } catch (error) {
        console.error('Error getting system info:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Table Logs API Endpoint (includes both completed and abandoned transactions)
app.get('/api/admin/table-logs', requireAdminAuth, async (req, res) => {
    try {
        const { dateFrom, dateTo } = req.query;
        const fromDate = dateFrom || new Date().toISOString().split('T')[0];
        const toDate = dateTo || new Date().toISOString().split('T')[0];
        
        const Database = require('./database');
        const db = new Database();
        
        // Get both print transactions and abandoned transactions
        const sqlPrint = `
            SELECT 
                pt.*,
                'completed' as transaction_type,
                CASE 
                    WHEN pt.total_cost > 0 AND pt.coins_used >= pt.total_cost THEN 1
                    ELSE 0
                END as success
            FROM print_transactions pt
            WHERE pt.date >= ? AND pt.date <= ?
        `;
        
        const sqlAbandoned = `
            SELECT 
                at.*,
                'abandoned' as transaction_type,
                0 as success
            FROM abandoned_transactions at
            WHERE at.date >= ? AND at.date <= ?
        `;
        
        // Get print transactions
        db.db.all(sqlPrint, [fromDate, toDate], (err, printRows) => {
            if (err) {
                console.error('Error getting print logs:', err);
                return res.status(500).json({ success: false, error: err.message });
            }
            
            // Get abandoned transactions
            db.db.all(sqlAbandoned, [fromDate, toDate], (err2, abandonedRows) => {
                if (err2) {
                    console.error('Error getting abandoned logs:', err2);
                    return res.status(500).json({ success: false, error: err2.message });
                }
                
                // Format print transactions
                const printLogs = printRows.map(row => ({
                    id: row.id,
                    filename: row.filename,
                    pages_printed: row.pages_printed,
                    paper_size: row.paper_size,
                    color_mode: row.color_mode,
                    total_cost: row.total_cost,
                    coins_used: row.coins_used,
                    change_given: row.change_given,
                    timestamp: row.timestamp,
                    success: row.success,
                    transaction_type: 'completed',
                    reason: null
                }));
                
                // Format abandoned transactions
                const abandonedLogs = abandonedRows.map(row => ({
                    id: `abandoned_${row.id}`,
                    filename: row.filename,
                    pages_printed: 0, // No pages printed for abandoned
                    paper_size: row.paper_size,
                    color_mode: row.color_mode,
                    total_cost: row.required_cost,
                    coins_used: row.coins_inserted,
                    change_given: 0,
                    timestamp: row.timestamp,
                    success: 0,
                    transaction_type: 'abandoned',
                    reason: row.reason,
                    amount_short: row.amount_short
                }));
                
                // Combine and sort by timestamp
                const allLogs = [...printLogs, ...abandonedLogs].sort((a, b) => b.timestamp - a.timestamp);
                
                // Calculate summary statistics
                const summary = {
                    total_transactions: allLogs.length,
                    successful_transactions: printLogs.filter(r => r.success).length,
                    failed_transactions: printLogs.filter(r => !r.success).length + abandonedLogs.length,
                    abandoned_transactions: abandonedLogs.length,
                    total_revenue: printLogs.reduce((sum, r) => sum + (r.total_cost || 0), 0)
                };
                
                res.json({ 
                    success: true, 
                    logs: allLogs,
                    summary: summary
                });
            });
        });
    } catch (error) {
        console.error('Error getting table logs:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Arduino Coin Listener API Endpoints
app.get('/api/arduino-status', (req, res) => {
    try {
        const status = coinListener.getConnectionStatus();
        let lastCoin = global.lastCoinDetected || null;
        
        // If there's a last coin, check if it's already claimed
        if (lastCoin) {
            const coinKey = `${lastCoin.timestamp}_${lastCoin.value}`;
            const claimedCoin = claimedCoins.get(coinKey);
            
            if (claimedCoin) {
                // Add session information to the coin
                lastCoin = {
                    ...lastCoin,
                    sessionId: claimedCoin.sessionId,
                    isClaimed: true
                };
            } else {
                // Coin is not claimed yet
                lastCoin = {
                    ...lastCoin,
                    isClaimed: false
                };
            }
        }
        
        res.json({
            success: true,
            arduino: status,
            lastCoin: lastCoin
        });
    } catch (error) {
        console.error('Error getting Arduino status:', error);
        res.status(500).json({ success: false, error: 'Failed to get Arduino status' });
    }
});

app.post('/api/arduino-test', (req, res) => {
    try {
        const success = coinListener.testConnection();
        res.json({
            success: true,
            testSent: success,
            message: success ? 'Test command sent to Arduino' : 'Arduino not connected'
        });
    } catch (error) {
        console.error('Error testing Arduino:', error);
        res.status(500).json({ success: false, error: 'Failed to test Arduino' });
    }
});

app.post('/api/arduino-reset', (req, res) => {
    try {
        // Reset the coin listener connection
        coinListener.cleanup();
        setTimeout(() => {
            coinListener.init();
        }, 1000);
        
        res.json({
            success: true,
            message: 'Arduino connection reset initiated'
        });
    } catch (error) {
        console.error('Error resetting Arduino:', error);
        res.status(500).json({ success: false, error: 'Failed to reset Arduino' });
    }
});

app.post('/api/arduino-set-port', (req, res) => {
    try {
        const { port } = req.body;
        
        if (!port) {
            return res.status(400).json({ 
                success: false, 
                error: 'Port parameter is required' 
            });
        }
        
        // Set the COM port manually
        coinListener.setComPort(port);
        
        res.json({
            success: true,
            message: `Arduino connection set to ${port}`
        });
    } catch (error) {
        console.error('Error setting Arduino port:', error);
        res.status(500).json({ success: false, error: 'Failed to set Arduino port' });
    }
});

app.post('/api/arduino-test-coins', (req, res) => {
    try {
        coinListener.sendCommand('TESTCOIN');
        
        res.json({
            success: true,
            message: 'Coin detection test sent to Arduino'
        });
    } catch (error) {
        console.error('Error testing coin detection:', error);
        res.status(500).json({ success: false, error: 'Failed to test coin detection' });
    }
});

app.post('/api/arduino-pin-status', (req, res) => {
    try {
        coinListener.sendCommand('PINSTATUS');
        
        res.json({
            success: true,
            message: 'Pin status check sent to Arduino'
        });
    } catch (error) {
        console.error('Error checking pin status:', error);
        res.status(500).json({ success: false, error: 'Failed to check pin status' });
    }
});

app.post('/api/arduino-debug-mode', (req, res) => {
    try {
        const { enable } = req.body;
        const command = enable ? 'DEBUGON' : 'DEBUGOFF';
        coinListener.sendCommand(command);
        
        res.json({
            success: true,
            message: `Debug mode ${enable ? 'enabled' : 'disabled'}`
        });
    } catch (error) {
        console.error('Error setting debug mode:', error);
        res.status(500).json({ success: false, error: 'Failed to set debug mode' });
    }
});

app.post('/api/arduino-detection-method', (req, res) => {
    try {
        const { method } = req.body;
        let command = '';
        
        switch (method) {
            case 1:
                command = 'METHOD1';
                break;
            case 2:
                command = 'METHOD2';
                break;
            case 3:
                command = 'METHOD3';
                break;
            default:
                return res.status(400).json({ 
                    success: false, 
                    error: 'Invalid method. Use 1, 2, or 3' 
                });
        }
        
        coinListener.sendCommand(command);
        
        res.json({
            success: true,
            message: `Detection method switched to ${method}`
        });
    } catch (error) {
        console.error('Error setting detection method:', error);
        res.status(500).json({ success: false, error: 'Failed to set detection method' });
    }
});

app.post('/api/arduino-invert-logic', (req, res) => {
    try {
        const { invert } = req.body;
        const command = invert ? 'INVERTLOGIC' : 'INVERTLOGIC';
        
        coinListener.sendCommand(command);
        
        res.json({
            success: true,
            message: `Logic ${invert ? 'inverted' : 'normalized'}`
        });
    } catch (error) {
        console.error('Error toggling logic:', error);
        res.status(500).json({ success: false, error: 'Failed to toggle logic' });
    }
});

app.post('/api/arduino-reset-detection', (req, res) => {
    try {
        coinListener.sendCommand('RESET');
        
        res.json({
            success: true,
            message: 'Coin detection reset'
        });
    } catch (error) {
        console.error('Error resetting detection:', error);
        res.status(500).json({ success: false, error: 'Failed to reset detection' });
    }
});

// Enable coin acceptance (called when user clicks "Proceed to Payment")
app.post('/api/arduino-enable-coins', (req, res) => {
    try {
        coinListener.sendCommand('ENABLE_COINS');
        
        res.json({
            success: true,
            message: 'Coin selector activated - ready to accept coins'
        });
    } catch (error) {
        console.error('Error enabling coins:', error);
        res.status(500).json({ success: false, error: 'Failed to enable coins' });
    }
});

// Disable coin acceptance
app.post('/api/arduino-disable-coins', (req, res) => {
    try {
        coinListener.sendCommand('DISABLE_COINS');
        
        res.json({
            success: true,
            message: 'Coin selector deactivated'
        });
    } catch (error) {
        console.error('Error disabling coins:', error);
        res.status(500).json({ success: false, error: 'Failed to disable coins' });
    }
});

// Test paper size configuration endpoint
app.post('/test-paper-size', express.json(), async (req, res) => {
    try {
        const { paperSize, printerName } = req.body;
        
        if (!paperSize || !printerName) {
            return res.status(400).json({
                success: false,
                error: 'Paper size and printer name are required'
            });
        }
        
        console.log(`Testing paper size configuration: ${paperSize} for printer: ${printerName}`);
        
        // Import the new paper size functions
        const { configurePrinterPaperSize } = require('./printer');
        
        // Test the paper size configuration
        const result = await configurePrinterPaperSize(printerName, paperSize);
        
        if (result.success) {
            res.json({
                success: true,
                message: result.message,
                printerName: printerName,
                paperSize: paperSize,
                method: 'PowerShell',
                output: result.message
            });
        } else {
            res.json({
                success: false,
                error: result.error,
                printerName: printerName,
                paperSize: paperSize
            });
        }
        
    } catch (error) {
        console.error('Error testing paper size configuration:', error);
        res.status(500).json({
            success: false,
            error: `Failed to test paper size configuration: ${error.message}`
        });
    }
});

// Printer Settings API Endpoints
app.get('/api/printer-config', requireAdminAuth, async (req, res) => {
    try {
        if (!IS_WINDOWS) {
            try {
                const cfg = getPrinterConfig();
                const dp = (cfg && cfg.DEFAULT_PRINTER) ? String(cfg.DEFAULT_PRINTER).trim() : '';
                const avail = Array.isArray(cfg && cfg.AVAILABLE_PRINTERS) ? cfg.AVAILABLE_PRINTERS : [];
                const shouldSync = !avail.length || (!!dp && !avail.includes(dp)) || (!dp && avail.length);
                if (shouldSync) {
                    await refreshAvailablePrinters();
                }
            } catch (_) {}
        }

        const config = getPrinterConfig();
        res.json({ success: true, config });
    } catch (error) {
        console.error('Error getting printer config:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/printer-config', requireAdminAuth, (req, res) => {
    try {
        const { updates } = req.body;
        
        if (!updates) {
            return res.status(400).json({ 
                success: false, 
                error: 'Updates object is required' 
            });
        }
        
        const result = updatePrinterConfig(updates);
        res.json(result);
    } catch (error) {
        console.error('Error updating printer config:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/printer-set-default', requireAdminAuth, (req, res) => {
    try {
        const { printerName } = req.body;
        
        if (!printerName) {
            return res.status(400).json({ 
                success: false, 
                error: 'Printer name is required' 
            });
        }
        
        const result = setDefaultPrinter(printerName);
        res.json(result);
    } catch (error) {
        console.error('Error setting default printer:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/printer-refresh', requireAdminAuth, async (req, res) => {
    try {
        const result = await refreshAvailablePrinters();
        res.json(result);
    } catch (error) {
        console.error('Error refreshing printers:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/printer-test-config', requireAdminAuth, async (req, res) => {
    try {
        const { printerName, paperSize, colorMode } = req.body;
        
        if (!printerName) {
            return res.status(400).json({ 
                success: false, 
                error: 'Printer name is required' 
            });
        }
        
        const result = await testPrinterConfiguration(
            printerName, 
            paperSize || 'short', 
            colorMode || 'grayscale'
        );
        res.json(result);
    } catch (error) {
        console.error('Error testing printer configuration:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Linux/Armbian CUPS Auto-Configuration API Endpoints
app.get('/api/cups/devices', requireAdminAuth, async (req, res) => {
    try {
        if (IS_WINDOWS) {
            return res.status(400).json({ success: false, error: 'CUPS device scan is only available on Linux' });
        }

        const r = await runCupsCommand('lpinfo', ['-v'], { timeout: 30000 });
        const lines = (r.stdout || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        const devices = [];

        for (const line of lines) {
            const m = line.match(/^(\S+)\s+(.+)$/);
            if (!m) continue;
            const klass = m[1];
            const rest = m[2];
            const uri = rest.trim();
            devices.push({ class: klass, uri });
        }

        res.json({ success: true, devices, usedSudo: r.usedSudo });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message, needsSudo: !!error.needsSudo });
    }
});

app.get('/api/cups/models', requireAdminAuth, async (req, res) => {
    try {
        if (IS_WINDOWS) {
            return res.status(400).json({ success: false, error: 'CUPS model list is only available on Linux' });
        }

        const q = (req.query.q || '').toString().trim().toLowerCase();
        const r = await runCupsCommand('lpinfo', ['-m'], { timeout: 60000 });
        const lines = (r.stdout || '').split(/\r?\n/);
        const parsedModels = [];
        for (const raw of lines) {
            const line = (raw || '').trim();
            if (!line) continue;
            let model = null;
            let ppd = null;
            let description = null;
            const m3 = line.match(/^(\S+)\s+(\S+)\s+(.+)$/);
            if (m3) {
                model = m3[1];
                ppd = m3[2];
                description = m3[3];
            } else {
                const m2 = line.match(/^(\S+)\s+(.+)$/);
                if (!m2) continue;
                model = m2[1];
                ppd = null;
                description = m2[2];
            }

            const hay = `${model} ${ppd || ''} ${description || ''}`.toLowerCase();
            if (q && !hay.includes(q)) continue;
            parsedModels.push({ model, ppd, description });
        }

        const builtinDrivers = [
            { model: 'everywhere', ppd: null, description: '[RECOMMENDED] IPP Everywhere / Driverless (works with most modern printers)' },
            { model: 'raw', ppd: null, description: 'Raw Queue (no processing, printer must handle data directly)' }
        ];

        const models = [];
        const seenModels = new Set();
        const includeBuiltins = !q || parsedModels.length === 0;
        if (includeBuiltins) {
            for (const bd of builtinDrivers) {
                models.push(bd);
                seenModels.add(bd.model);
            }
        }

        for (const m of parsedModels) {
            if (!m || !m.model) continue;
            if (seenModels.has(m.model)) continue;
            models.push(m);
            seenModels.add(m.model);
        }

        res.json({ success: true, models, usedSudo: r.usedSudo });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message, needsSudo: !!error.needsSudo });
    }
});

app.post('/api/cups/auto-configure', requireAdminAuth, async (req, res) => {
    try {
        if (IS_WINDOWS) {
            return res.status(400).json({ success: false, error: 'CUPS auto-configuration is only available on Linux' });
        }

        const printerNameRaw = (req.body?.printerName || '').toString().trim();
        const deviceUri = (req.body?.deviceUri || '').toString().trim();
        const model = (req.body?.model || '').toString().trim();
        const setDefault = req.body?.setDefault !== false;

        if (!printerNameRaw || !deviceUri || !model) {
            return res.status(400).json({
                success: false,
                error: 'printerName, deviceUri, and model are required'
            });
        }

        const printerName = printerNameRaw.replace(/\s+/g, '_').replace(/[^A-Za-z0-9._-]/g, '_');

        const steps = [];
        const pushStep = (name, result) => {
            steps.push({
                name,
                usedSudo: !!result.usedSudo,
                stdout: (result.stdout || '').trim() || null,
                stderr: (result.stderr || '').trim() || null
            });
        };

        const r1 = await runCupsCommand('lpadmin', ['-p', printerName, '-v', deviceUri, '-m', model, '-E'], { timeout: 60000 });
        pushStep('lpadmin_add_or_update', r1);

        const r2 = await runCupsCommand('cupsenable', [printerName], { timeout: 30000 });
        pushStep('cupsenable', r2);

        const r3 = await runCupsCommand('cupsaccept', [printerName], { timeout: 30000 });
        pushStep('cupsaccept', r3);

        if (setDefault) {
            const r4 = await runCupsCommand('lpadmin', ['-d', printerName], { timeout: 30000 });
            pushStep('lpadmin_set_default', r4);
        }

        // Update PisoPrinter config so the app uses the queue name
        setDefaultPrinter(printerName);
        updatePrinterConfig({
            DEFAULTS: {
                ...(getPrinterConfig().DEFAULTS || {}),
                printerName
            }
        });

        // Refresh list stored in printer_config.js
        try {
            await refreshAvailablePrinters();
        } catch (_) {
            // ignore
        }

        res.json({ success: true, printerName, deviceUri, model, steps });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message, needsSudo: !!error.needsSudo });
    }
});

// Health check endpoint
app.get('/api/health', async (req, res) => {
    try {
        const libreOfficeAvailable = await checkLibreOffice();
        const cmd = await resolveLibreOfficeCmd();
        res.json({ 
            status: 'ok', 
            libreOffice: libreOfficeAvailable,
            cli: cmd || null
        });
    } catch (error) {
        res.status(500).json({ 
            status: 'error', 
            error: error.message 
        });
    }
});

// Pricing Configuration Endpoints

// Public endpoint for pricing configuration (no auth required for main interface)
app.get('/api/pricing-config', (req, res) => {
    try {
        const configPath = path.join(__dirname, 'pricing-config.json');
        
        if (fs.existsSync(configPath)) {
            const configData = fs.readFileSync(configPath, 'utf8');
            const pricingConfig = JSON.parse(configData);
            
            res.json({
                success: true,
                data: pricingConfig
            });
        } else {
            // Return default configuration if file doesn't exist
            const defaultConfig = {
                shortPaper: {
                    grayscale: 3.00,
                    colored: 5.40
                },
                longPaper: {
                    grayscale: 5.00,
                    colored: 9.00
                },
                lastUpdated: new Date().toISOString()
            };
            
            res.json({
                success: true,
                data: defaultConfig
            });
        }
    } catch (error) {
        console.error('Error reading pricing configuration:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Error reading pricing configuration' 
        });
    }
});

// Admin endpoint for pricing configuration (requires authentication)
app.get('/api/admin/pricing-config', requireAdminAuth, (req, res) => {
    try {
        const configPath = path.join(__dirname, 'pricing-config.json');
        
        if (fs.existsSync(configPath)) {
            const configData = fs.readFileSync(configPath, 'utf8');
            const pricingConfig = JSON.parse(configData);
            
            res.json({
                success: true,
                data: pricingConfig
            });
        } else {
            // Return default configuration if file doesn't exist
            const defaultConfig = {
                shortPaper: {
                    grayscale: 3.00,
                    colored: 5.40
                },
                longPaper: {
                    grayscale: 5.00,
                    colored: 9.00
                },
                lastUpdated: new Date().toISOString()
            };
            
            res.json({
                success: true,
                data: defaultConfig
            });
        }
    } catch (error) {
        console.error('Error reading pricing configuration:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Error reading pricing configuration' 
        });
    }
});

// Save pricing configuration
app.post('/api/admin/pricing-config', requireAdminAuth, (req, res) => {
    try {
        const { shortPaper, longPaper } = req.body;
        
        // Validate the configuration
        if (!shortPaper || !longPaper) {
            return res.status(400).json({ 
                success: false, 
                error: 'Missing shortPaper or longPaper configuration' 
            });
        }
        
        if (!shortPaper.grayscale || !shortPaper.colored || !longPaper.grayscale || !longPaper.colored) {
            return res.status(400).json({ 
                success: false, 
                error: 'Missing pricing values for paper sizes or color modes' 
            });
        }
        
        // Validate that all values are numbers and positive
        const values = [shortPaper.grayscale, shortPaper.colored, longPaper.grayscale, longPaper.colored];
        for (const value of values) {
            if (isNaN(value) || value < 0) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'All pricing values must be valid positive numbers' 
                });
            }
        }
        
        // Create the configuration object
        const pricingConfig = {
            shortPaper: {
                grayscale: parseFloat(shortPaper.grayscale),
                colored: parseFloat(shortPaper.colored)
            },
            longPaper: {
                grayscale: parseFloat(longPaper.grayscale),
                colored: parseFloat(longPaper.colored)
            },
            lastUpdated: new Date().toISOString()
        };
        
        // Save to file
        const configPath = path.join(__dirname, 'pricing-config.json');
        fs.writeFileSync(configPath, JSON.stringify(pricingConfig, null, 2));
        
        res.json({
            success: true,
            message: 'Pricing configuration saved successfully',
            data: pricingConfig
        });
        
    } catch (error) {
        console.error('Error saving pricing configuration:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Error saving pricing configuration' 
        });
    }
});

// Queue Management API Endpoints

// Join the print queue
app.post('/api/queue/join', (req, res) => {
    try {
        const { sessionId, fileName, pageCount } = req.body;
        
        if (!sessionId) {
            return res.status(400).json({
                success: false,
                error: 'Session ID is required'
            });
        }
        
        const queueStatus = queueManager.joinQueue(sessionId, {
            fileName: fileName || 'Unknown file',
            pageCount: pageCount || 0,
            timestamp: Date.now()
        });
        
        res.json({
            success: true,
            ...queueStatus
        });
    } catch (error) {
        console.error('Error joining queue:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to join queue'
        });
    }
});

// Get queue status for a session
app.get('/api/queue/status/:sessionId', (req, res) => {
    try {
        const { sessionId } = req.params;
        const status = queueManager.getQueueStatus(sessionId);
        
        res.json({
            success: true,
            ...status
        });
    } catch (error) {
        console.error('Error getting queue status:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get queue status'
        });
    }
});

// Update session activity (heartbeat)
app.post('/api/queue/heartbeat', (req, res) => {
    try {
        const { sessionId } = req.body;
        
        if (!sessionId) {
            return res.status(400).json({
                success: false,
                error: 'Session ID is required'
            });
        }
        
        queueManager.updateActivity(sessionId);
        const status = queueManager.getQueueStatus(sessionId);
        
        res.json({
            success: true,
            ...status
        });
    } catch (error) {
        console.error('Error updating session activity:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to update session activity'
        });
    }
});

// Leave the queue
app.post('/api/queue/leave', (req, res) => {
    try {
        const { sessionId } = req.body;
        
        if (!sessionId) {
            return res.status(400).json({
                success: false,
                error: 'Session ID is required'
            });
        }
        
        queueManager.removeSession(sessionId);
        
        res.json({
            success: true,
            message: 'Left the queue successfully'
        });
    } catch (error) {
        console.error('Error leaving queue:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to leave queue'
        });
    }
});

// Get overall queue information (admin endpoint)
app.get('/api/queue/info', (req, res) => {
    try {
        const queueInfo = queueManager.getQueueInfo();
        
        res.json({
            success: true,
            ...queueInfo
        });
    } catch (error) {
        console.error('Error getting queue info:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get queue information'
        });
    }
});

// Record abandoned transaction (incomplete payment)
app.post('/api/abandoned-transaction', (req, res) => {
    try {
        const { filename, pagesToPrint, paperSize, colorMode, requiredCost, coinsInserted, reason, sessionId } = req.body;
        
        if (!filename || !pagesToPrint || !requiredCost) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields'
            });
        }
        
        const Database = require('./database');
        const db = new Database();
        
        db.recordAbandonedTransaction(
            filename,
            pagesToPrint,
            paperSize || 'unknown',
            colorMode || 'unknown',
            requiredCost,
            coinsInserted || 0,
            reason || 'Unknown',
            sessionId
        ).then(result => {
            console.log(`📝 Abandoned transaction logged: ${filename} - ${reason} (Required: ₱${requiredCost}, Inserted: ₱${coinsInserted || 0})`);
            res.json({
                success: true,
                message: 'Abandoned transaction recorded',
                abandonedId: result.abandonedId
            });
        }).catch(error => {
            console.error('Error recording abandoned transaction:', error);
            res.status(500).json({
                success: false,
                error: 'Failed to record abandoned transaction'
            });
        });
    } catch (error) {
        console.error('Error recording abandoned transaction:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to record abandoned transaction'
        });
    }
});

// Session-based coin tracking
const claimedCoins = new Map(); // Store claimed coins with session info

// Endpoint to claim a coin for a specific session
app.post('/api/claim-coin', (req, res) => {
    try {
        const { timestamp, value, sessionId } = req.body;
        
        if (!timestamp || !value || !sessionId) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: timestamp, value, sessionId'
            });
        }
        
        const coinKey = `${timestamp}_${value}`;
        
        // Store the claimed coin with session info
        claimedCoins.set(coinKey, {
            timestamp: timestamp,
            value: value,
            sessionId: sessionId,
            claimedAt: Date.now()
        });
        
        console.log(`Coin claimed: ${coinKey} for session: ${sessionId}`);
        
        res.json({
            success: true,
            message: 'Coin claimed successfully',
            coinKey: coinKey
        });
        
    } catch (error) {
        console.error('Error claiming coin:', error);
        res.status(500).json({
            success: false,
            error: 'Error claiming coin'
        });
    }
});

// Cleanup old claimed coins (older than 5 minutes)
setInterval(() => {
    const now = Date.now();
    const fiveMinutesAgo = now - (5 * 60 * 1000);
    
    for (const [coinKey, coinData] of claimedCoins.entries()) {
        if (coinData.claimedAt < fiveMinutesAgo) {
            claimedCoins.delete(coinKey);
            console.log(`Cleaned up old claimed coin: ${coinKey}`);
        }
    }
}, 60000); // Run every minute

app.get('*', (req, res) => {
    if (req.path === '/log.html') {
        return res.sendFile(path.join(__dirname, 'log.html'));
    }
    res.redirect(302, CAPTIVE_PORTAL_URL);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log('Make sure LibreOffice is installed for accurate DOCX page counting');
    console.log(`📁 File retention: Uploaded files will be automatically deleted after 30 minutes`);
    console.log(`🧹 Cleanup: Running every 2 minutes to remove expired files`);
    ensureDirectoryExists(SAVED_DIR);
    cleanupExpiredSavedFiles();
});
