const { exec, execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const IS_WINDOWS = process.platform === 'win32';

// Load printer configuration
const printerConfig = require('./printer_config');

// Get default printer from configuration
let DEFAULT_PRINTER = printerConfig.DEFAULT_PRINTER;

// Paper size definitions from configuration
const PAPER_SIZES = printerConfig.PAPER_SIZES;

function normalizeColorMode(mode) {
    const m = String(mode || '').trim().toLowerCase();
    if (m === 'colored' || m === 'color' || m === 'colour') return 'colored';
    if (m === 'grayscale' || m === 'greyscale' || m === 'gray' || m === 'grey' || m === 'mono' || m === 'monochrome' || m === 'bw' || m === 'b&w' || m === 'blackwhite' || m === 'black-and-white') return 'grayscale';
    return 'grayscale';
}

async function convertPdfToGrayscale(inputPdfPath) {
    const lower = String(inputPdfPath || '').toLowerCase();
    if (!lower.endsWith('.pdf')) return null;

    const outPath = path.join(
        path.dirname(inputPdfPath),
        `grayscale_${Date.now()}_${Math.random().toString(16).slice(2)}.pdf`
    );

    const args = [
        '-sDEVICE=pdfwrite',
        '-dCompatibilityLevel=1.4',
        '-dNOPAUSE',
        '-dBATCH',
        '-dSAFER',
        '-sColorConversionStrategy=Gray',
        '-dProcessColorModel=/DeviceGray',
        `-sOutputFile=${outPath}`,
        inputPdfPath
    ];

    const candidates = ['gs', '/usr/bin/gs', '/usr/local/bin/gs', '/bin/gs'];
    let lastErr = null;

    for (const gsCmd of candidates) {
        try {
            await execFileAsync(gsCmd, args, { timeout: 120000 });
            if (fs.existsSync(outPath)) {
                return outPath;
            }
            throw new Error('Ghostscript did not produce output PDF');
        } catch (e) {
            lastErr = e;
            if (e && (e.code === 'ENOENT' || e.errno === 'ENOENT')) {
                continue;
            }
            throw e;
        }
    }

    if (lastErr && (lastErr.code === 'ENOENT' || lastErr.errno === 'ENOENT')) {
        return null;
    }

    throw lastErr || new Error('Failed to convert PDF to grayscale');
}

async function getPrintersLinux() {
    try {
        const result = await execAsync('lpstat -p');
        const rawLines = (result.stdout || '').split(/\r?\n/);

        const deviceUris = {};
        try {
            const v = await execAsync('lpstat -v');
            const vLines = (v.stdout || '').split(/\r?\n/);
            for (const line of vLines) {
                const trimmed = (line || '').trim();
                if (!trimmed) continue;
                const m = trimmed.match(/^device\s+for\s+(\S+):\s*(.+)$/i);
                if (m && m[1] && m[2]) {
                    deviceUris[m[1]] = m[2].trim();
                }
            }
        } catch (_) {
            // ignore
        }

        const printers = [];
        let current = null;

        for (const line of rawLines) {
            const trimmed = (line || '').trim();
            if (!trimmed) continue;

            if (trimmed.startsWith('printer ')) {
                if (current) printers.push(current);

                const parts = trimmed.split(/\s+/);
                const name = parts[1];
                const lower = trimmed.toLowerCase();
                let status = 'Unknown';
                if (lower.includes('disabled')) status = 'Disabled';
                else if (lower.includes('idle')) status = 'Idle';
                else if (lower.includes('printing')) status = 'Printing';

                current = {
                    Name: name,
                    PrinterStatus: status,
                    StatusDetails: null,
                    DeviceUri: deviceUris[name] || null,
                    DriverName: null
                };
                continue;
            }

            if (current) {
                current.StatusDetails = current.StatusDetails ? `${current.StatusDetails}; ${trimmed}` : trimmed;
                const lower = trimmed.toLowerCase();
                if (lower.includes('waiting for printer') || lower.includes('become available') || lower.includes('unavailable')) {
                    current.PrinterStatus = 'Unavailable';
                }
            }
        }

        if (current) printers.push(current);

        return { success: true, printers };
    } catch (error) {
        const errText = `${error?.stderr || ''}\n${error?.stdout || ''}\n${error?.message || ''}`.toLowerCase();
        if (errText.includes('no destinations added')) {
            return { success: true, printers: [] };
        }
        return { success: false, error: error.message, printers: [] };
    }
}

async function resolveLinuxPrinterName(requestedPrinterName) {
    const trimmed = (requestedPrinterName || '').trim();
    if (trimmed) {
        try {
            const list = await getPrintersLinux();
            const exists = list.success && list.printers.some(p => p.Name === trimmed);
            if (exists) return trimmed;
        } catch (_) {}
    }

    try {
        const { stdout } = await execAsync('lpstat -d');
        const m = (stdout || '').match(/system default destination:\s*(\S+)/i);
        if (m && m[1]) return m[1];
    } catch (_) {}

    try {
        const list = await getPrintersLinux();
        if (list.success && list.printers.length > 0) return list.printers[0].Name;
    } catch (_) {}

    return null;
}

async function printWithCups(filePath, printerName, paperSize, colorMode) {
    const paperConfig = PAPER_SIZES[paperSize];
    if (!paperConfig) {
        throw new Error(`Unknown paper size: ${paperSize}`);
    }

    const effectiveColorMode = normalizeColorMode(colorMode);

    const requestedPrinterName = (process.env.PRINTER_NAME || printerName || '').trim();
    const effectivePrinter = await resolveLinuxPrinterName(requestedPrinterName);

    const args = [];
    if (effectivePrinter) {
        args.push('-d', effectivePrinter);
    }

    args.push('-o', `media=${paperConfig.name}`);

    // Epson ESC/P-R driver exposes a PPD option: Ink/Grayscale: COLOR or MONO
    // Setting Ink=MONO forces grayscale more reliably than generic print-color-mode.
    const inkValue = effectiveColorMode === 'colored' ? 'COLOR' : 'MONO';
    const argsWithInk = [...args, '-o', `Ink=${inkValue}`];

    if (effectiveColorMode === 'colored') {
        argsWithInk.push('-o', 'print-color-mode=color');
    } else {
        argsWithInk.push('-o', 'print-color-mode=monochrome');
        argsWithInk.push('-o', 'ColorModel=Gray');
    }

    const argsWithoutInk = [...args];
    if (effectiveColorMode === 'colored') {
        argsWithoutInk.push('-o', 'print-color-mode=color');
    } else {
        argsWithoutInk.push('-o', 'print-color-mode=monochrome');
        argsWithoutInk.push('-o', 'ColorModel=Gray');
    }

    argsWithInk.push(filePath);
    argsWithoutInk.push(filePath);

    let usedArgs = argsWithInk;
    let result;
    try {
        result = await execFileAsync('lp', argsWithInk, { timeout: 60000 });
    } catch (e) {
        const stderr = (e && e.stderr) ? String(e.stderr) : '';
        if (/unknown\s+option|bad\s+option|unsupported\s+option/i.test(stderr) && /\bInk\b/i.test(stderr)) {
            usedArgs = argsWithoutInk;
            result = await execFileAsync('lp', argsWithoutInk, { timeout: 60000 });
        } else {
            throw e;
        }
    }
    const stdout = (result.stdout || '').trim();
    const stderr = (result.stderr || '').trim();

    // Example output: "request id is PRINTER-123 (1 file(s))"
    let jobId = null;
    const reqMatch = stdout.match(/request\s+id\s+is\s+(\S+)/i);
    if (reqMatch && reqMatch[1]) {
        jobId = reqMatch[1];
    } else {
        const altMatch = stdout.match(/\b(\S+-\d+)\b/);
        if (altMatch && altMatch[1]) {
            jobId = altMatch[1];
        }
    }

    return {
        success: true,
        message: 'Document sent to printer via CUPS (lp)',
        method: 'cups',
        printer: effectivePrinter || '(CUPS default)',
        jobId,
        command: `lp ${usedArgs.join(' ')}`,
        output: stdout || 'No output',
        errorOutput: stderr || null
    };
}

/**
 * Configure printer with specific paper size settings
 */
async function configurePrinterPaperSize(printerName, paperSize) {
    try {
        if (!IS_WINDOWS) {
            return { success: true, message: 'Printer configuration is handled by CUPS/job options on this OS' };
        }

        console.log(`Configuring printer ${printerName} for ${paperSize} paper`);
        
        const paperConfig = PAPER_SIZES[paperSize];
        if (!paperConfig) {
            throw new Error(`Unknown paper size: ${paperSize}`);
        }
        
        // Method 1: Use PowerShell to set printer properties
        const psScript = `
$printerName = "${printerName}"
$paperSize = "${paperSize}"
$paperConfig = @{
    'PageMediaSize' = '${paperConfig.driverSettings.PageMediaSize}'
    'PageMediaType' = '${paperConfig.driverSettings.PageMediaType}'
    'PageOrientation' = '${paperConfig.driverSettings.PageOrientation}'
}

Write-Host "Configuring printer: $printerName"
Write-Host "Paper size: $paperSize (${paperConfig.name})"
Write-Host "Dimensions: ${paperConfig.width}" x ${paperConfig.height} inches"

try {
    # Get printer object
    $printer = Get-Printer -Name $printerName -ErrorAction Stop
    Write-Host "Found printer: $($printer.Name)"
    
    # Set each printer property
    foreach ($prop in $paperConfig.GetEnumerator()) {
        try {
            Set-PrinterProperty -PrinterName $printerName -PropertyName $prop.Key -Value $prop.Value -ErrorAction Stop
            Write-Host "Set $($prop.Key) = $($prop.Value)"
        } catch {
            Write-Host "Could not set $($prop.Key): $_"
        }
    }
    
    # Try to set paper size using alternative property names
    $alternativeProps = @{
        'PageSize' = '${paperConfig.driverSettings.PageMediaSize}'
        'PaperSize' = '${paperConfig.driverSettings.PageMediaSize}'
        'MediaSize' = '${paperConfig.driverSettings.PageMediaSize}'
        'Paper' = '${paperConfig.driverSettings.PageMediaSize}'
    }
    
    foreach ($prop in $alternativeProps.GetEnumerator()) {
        try {
            Set-PrinterProperty -PrinterName $printerName -PropertyName $prop.Key -Value $prop.Value -ErrorAction SilentlyContinue
            Write-Host "Set alternative $($prop.Key) = $($prop.Value)"
        } catch {
            Write-Host "Could not set alternative $($prop.Key)"
        }
    }
    
    # Epson-specific settings
    if ($printerName -like "*Epson*" -or $printerName -like "*EPSON*") {
        Write-Host "Applying Epson-specific settings..."
        
        $epsonProps = @{
            'PageMediaSize' = '${paperConfig.driverSettings.PageMediaSize}'
            'PageMediaType' = '${paperConfig.driverSettings.PageMediaType}'
            'PageOrientation' = '${paperConfig.driverSettings.PageOrientation}'
            'PaperSize' = '${paperConfig.driverSettings.PageMediaSize}'
            'MediaSize' = '${paperConfig.driverSettings.PageMediaSize}'
        }
        
        foreach ($prop in $epsonProps.GetEnumerator()) {
            try {
                Set-PrinterProperty -PrinterName $printerName -PropertyName $prop.Key -Value $prop.Value -ErrorAction SilentlyContinue
                Write-Host "Set Epson $($prop.Key) = $($prop.Value)"
            } catch {
                Write-Host "Could not set Epson $($prop.Key)"
            }
        }
    }
    
    Write-Host "Printer configuration completed"
    
} catch {
    Write-Error "Failed to configure printer: $_"
    exit 1
}
`;
        
        const tempScriptPath = path.join(__dirname, 'temp_paper_config.ps1');
        fs.writeFileSync(tempScriptPath, psScript);
        
        const command = `powershell -ExecutionPolicy Bypass -File "${tempScriptPath}"`;
        const result = await execAsync(command, { timeout: 30000 });
        
        // Clean up temp script
        fs.unlinkSync(tempScriptPath);
        
        console.log('Printer configuration result:', result.stdout);
        return { success: true, message: `Printer configured for ${paperSize} paper` };
        
    } catch (error) {
        console.error('Error configuring printer paper size:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Create print job with specific paper size settings
 */
async function createPrintJobWithPaperSize(filePath, printerName, paperSize, colorMode) {
    try {
        if (!IS_WINDOWS) {
            return { success: false, error: 'createPrintJobWithPaperSize is only supported on Windows in this build' };
        }

        console.log(`Creating print job with ${paperSize} paper size`);
        
        const paperConfig = PAPER_SIZES[paperSize];
        if (!paperConfig) {
            throw new Error(`Unknown paper size: ${paperSize}`);
        }
        
        // Method 1: Use Windows print command with specific settings
        const printCommand = `print "${filePath}" /d:"${printerName}"`;
        
        // Method 2: Use PowerShell to create print job with specific settings
        const psScript = `
$filePath = "${filePath.replace(/\\/g, '\\\\')}"
$printerName = "${printerName}"
$paperSize = "${paperSize}"
$colorMode = "${colorMode}"

Write-Host "Creating print job for: $filePath"
Write-Host "Printer: $printerName"
Write-Host "Paper size: $paperSize"
Write-Host "Color mode: $colorMode"

try {
    # Get printer object
    $printer = Get-Printer -Name $printerName -ErrorAction Stop
    
    # Create print job with specific settings
    $printJob = Start-Job -ScriptBlock {
        param($file, $printer, $paper, $color)
        
        # Set printer properties for this job
        $paperConfig = @{
            'PageMediaSize' = if ($paper -eq 'long') { 'Legal' } else { 'Letter' }
            'PageMediaType' = 'Plain'
            'PageOrientation' = 'Portrait'
        }
        
        foreach ($prop in $paperConfig.GetEnumerator()) {
            try {
                Set-PrinterProperty -PrinterName $printer -PropertyName $prop.Key -Value $prop.Value -ErrorAction SilentlyContinue
            } catch {
                Write-Host "Could not set $($prop.Key)"
            }
        }
        
        # Print the file
        Start-Process -FilePath $file -Verb Print -PassThru
        
    } -ArgumentList $filePath, $printerName, $paperSize, $colorMode
    
    Write-Host "Print job created successfully"
    return $printJob.Id
    
} catch {
    Write-Error "Failed to create print job: $_"
    exit 1
}
`;
        
        const tempScriptPath = path.join(__dirname, 'temp_print_job.ps1');
        fs.writeFileSync(tempScriptPath, psScript);
        
        const command = `powershell -ExecutionPolicy Bypass -File "${tempScriptPath}"`;
        const result = await execAsync(command, { timeout: 30000 });
        
        // Clean up temp script
        fs.unlinkSync(tempScriptPath);
        
        console.log('Print job creation result:', result.stdout);
        return { success: true, message: 'Print job created with paper size settings' };
        
    } catch (error) {
        console.error('Error creating print job with paper size:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Use Windows print command with specific paper size settings
 */
async function printWithWindowsPrint(filePath, printerName, paperSize, colorMode) {
    try {
        if (!IS_WINDOWS) {
            return { success: false, error: 'Windows print method is not available on this OS' };
        }

        console.log(`Using Windows print command for ${paperSize} paper`);
        
        const paperConfig = PAPER_SIZES[paperSize];
        if (!paperConfig) {
            throw new Error(`Unknown paper size: ${paperSize}`);
        }
        
        // Create a batch file that sets printer properties and prints
        const batchContent = `@echo off
echo Configuring printer for ${paperSize} paper...
echo Printer: ${printerName}
echo Paper size: ${paperConfig.name}
echo Dimensions: ${paperConfig.width}" x ${paperConfig.height}"

REM Set printer properties using PowerShell
powershell -Command "& {
    $printerName = '${printerName}'
    $paperSize = '${paperSize}'
    
    try {
        # Configure printer for paper size
        $props = @{
            'PageMediaSize' = '${paperConfig.driverSettings.PageMediaSize}'
            'PageMediaType' = '${paperConfig.driverSettings.PageMediaType}'
            'PageOrientation' = '${paperConfig.driverSettings.PageOrientation}'
        }
        
        foreach ($prop in $props.GetEnumerator()) {
            try {
                Set-PrinterProperty -PrinterName $printerName -PropertyName $prop.Key -Value $prop.Value -ErrorAction SilentlyContinue
                echo Set $($prop.Key) = $($prop.Value)
            } catch {
                echo Could not set $($prop.Key)
            }
        }
        
        # Try alternative property names
        $altProps = @{
            'PageSize' = '${paperConfig.driverSettings.PageMediaSize}'
            'PaperSize' = '${paperConfig.driverSettings.PageMediaSize}'
            'MediaSize' = '${paperConfig.driverSettings.PageMediaSize}'
        }
        
        foreach ($prop in $altProps.GetEnumerator()) {
            try {
                Set-PrinterProperty -PrinterName $printerName -PropertyName $prop.Key -Value $prop.Value -ErrorAction SilentlyContinue
                echo Set alternative $($prop.Key) = $($prop.Value)
            } catch {
                echo Could not set alternative $($prop.Key)
            }
        }
        
        echo Printer configured successfully
    } catch {
        echo Error configuring printer: $_
    }
}"

REM Print the file using Windows print command
echo Printing file: ${filePath}
print "${filePath}" /d:"${printerName}"

if %ERRORLEVEL% EQU 0 (
    echo Print job sent successfully
) else (
    echo Print job failed with error code %ERRORLEVEL%
    exit /b 1
)
`;
        
        const tempBatchPath = path.join(__dirname, 'temp_print.bat');
        fs.writeFileSync(tempBatchPath, batchContent);
        
        const command = `cmd /c "${tempBatchPath}"`;
        const result = await execAsync(command, { timeout: 60000 });
        
        // Clean up temp batch file
        fs.unlinkSync(tempBatchPath);
        
        console.log('Windows print result:', result.stdout);
        
        if (result.stderr) {
            console.warn('Windows print warnings:', result.stderr);
        }
        
        return {
            success: true,
            message: `Document sent to printer via Windows print command with ${paperSize} paper settings`,
            method: 'windows_print',
            command: command,
            output: result.stdout || 'No output'
        };
        
    } catch (error) {
        console.error('Windows print error:', error);
        return {
            success: false,
            error: `Windows print failed: ${error.message}`
        };
    }
}

/**
 * Create a new file containing only the specified page range
 */
async function createPageRangeFile(filePath, pageRange) {
    try {
        const extension = path.extname(filePath).toLowerCase();
        const tempDir = path.dirname(filePath);
        const tempFileName = `page_range_${Date.now()}_${pageRange.startPage}-${pageRange.endPage}${extension}`;
        const tempFilePath = path.join(tempDir, tempFileName);
        
        if (extension === '.pdf') {
            return await createPdfPageRange(filePath, tempFilePath, pageRange);
        } else if (extension === '.docx') {
            return await createDocxPageRange(filePath, tempFilePath, pageRange);
        } else if (extension === '.html' || extension === '.htm') {
            return await createHtmlPageRange(filePath, tempFilePath, pageRange);
        } else {
            // For other file types, just copy the original (can't extract pages)
            console.log('Page range not supported for this file type, printing full document');
            return null;
        }
    } catch (error) {
        console.error('Error creating page range file:', error);
        throw error;
    }
}

/**
 * Create PDF with specific page range using pdf-lib
 */
async function createPdfPageRange(inputPath, outputPath, pageRange) {
    try {
        const { PDFDocument } = require('pdf-lib');
        
        // Read the input PDF
        const inputBytes = fs.readFileSync(inputPath);
        let inputDoc;
        try {
            inputDoc = await PDFDocument.load(inputBytes);
        } catch (loadError) {
            const msg = (loadError && loadError.message) ? loadError.message : String(loadError);
            if (msg.toLowerCase().includes('encrypted')) {
                console.warn('Input PDF appears to be encrypted; retrying with ignoreEncryption=true for page range extraction');
                inputDoc = await PDFDocument.load(inputBytes, { ignoreEncryption: true });
            } else {
                throw loadError;
            }
        }
        
        // Create a new PDF document
        const outputDoc = await PDFDocument.create();
        
        // Get the specified pages (convert to 0-based indexing)
        const startPage = Math.max(0, pageRange.startPage - 1);
        const endPage = Math.min(inputDoc.getPageCount() - 1, pageRange.endPage - 1);
        
        console.log(`PDF page range processing: input has ${inputDoc.getPageCount()} pages`);
        console.log(`Requested pages ${pageRange.startPage}-${pageRange.endPage} (0-based: ${startPage}-${endPage})`);
        
        // Copy pages from start to end
        for (let i = startPage; i <= endPage; i++) {
            console.log(`Copying page ${i + 1} (0-based index: ${i})`);
            const [copiedPage] = await outputDoc.copyPages(inputDoc, [i]);
            outputDoc.addPage(copiedPage);
        }
        
        // Save the new PDF
        const outputBytes = await outputDoc.save();
        fs.writeFileSync(outputPath, outputBytes);
        
        console.log(`Created PDF with pages ${pageRange.startPage}-${pageRange.endPage}`);
        return outputPath;
        
    } catch (error) {
        console.error('Error creating PDF page range:', error);
        throw new Error(`Failed to create PDF page range: ${error.message}`);
    }
}

/**
 * Create DOCX with specific page range using LibreOffice
 */
async function createDocxPageRange(inputPath, outputPath, pageRange) {
    try {
        // First convert DOCX to PDF
        const tempPdfPath = path.join(path.dirname(inputPath), `temp_${Date.now()}.pdf`);
        
        // Use LibreOffice to convert DOCX to PDF
        const libreOfficeCmd = await resolveLibreOfficeCmd();
        if (!libreOfficeCmd) {
            throw new Error('LibreOffice not available for DOCX page range extraction');
        }
        
        const convertCommand = `"${libreOfficeCmd}" --headless --convert-to pdf --outdir "${path.dirname(tempPdfPath)}" "${inputPath}"`;
        await execAsync(convertCommand);
        
        // Find the converted PDF
        const expectedPdfPath = path.join(
            path.dirname(tempPdfPath),
            `${path.basename(inputPath, path.extname(inputPath))}.pdf`
        );
        
        if (!fs.existsSync(expectedPdfPath)) {
            throw new Error('Failed to convert DOCX to PDF');
        }
        
        // Create page range PDF
        const pageRangePdfPath = await createPdfPageRange(expectedPdfPath, outputPath, pageRange);
        
        // Clean up temporary PDF
        try {
            fs.unlinkSync(expectedPdfPath);
        } catch (cleanupError) {
            console.warn('Could not clean up temp PDF:', cleanupError.message);
        }
        
        return pageRangePdfPath;
        
    } catch (error) {
        console.error('Error creating DOCX page range:', error);
        throw new Error(`Failed to create DOCX page range: ${error.message}`);
    }
}

/**
 * Create HTML with specific page range using LibreOffice
 */
async function createHtmlPageRange(inputPath, outputPath, pageRange) {
    try {
        // First convert HTML to PDF
        const tempPdfPath = path.join(path.dirname(inputPath), `temp_${Date.now()}.pdf`);
        
        // Use LibreOffice to convert HTML to PDF
        const libreOfficeCmd = await resolveLibreOfficeCmd();
        if (!libreOfficeCmd) {
            throw new Error('LibreOffice not available for HTML page range extraction');
        }
        
        const convertCommand = `"${libreOfficeCmd}" --headless --convert-to pdf --outdir "${path.dirname(tempPdfPath)}" "${inputPath}"`;
        await execAsync(convertCommand);
        
        // Find the converted PDF
        const expectedPdfPath = path.join(
            path.dirname(tempPdfPath),
            `${path.basename(inputPath, path.extname(inputPath))}.pdf`
        );
        
        if (!fs.existsSync(expectedPdfPath)) {
            throw new Error('Failed to convert HTML to PDF');
        }
        
        // Create page range PDF
        const pageRangePdfPath = await createPdfPageRange(expectedPdfPath, outputPath, pageRange);
        
        // Clean up temporary PDF
        try {
            fs.unlinkSync(expectedPdfPath);
        } catch (cleanupError) {
            console.warn('Could not clean up temp PDF:', cleanupError.message);
        }
        
        return pageRangePdfPath;
        
    } catch (error) {
        console.error('Error creating HTML page range:', error);
        throw new Error(`Failed to create HTML page range: ${error.message}`);
    }
}

/**
 * Resolve LibreOffice command (helper function)
 */
async function resolveLibreOfficeCmd() {
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
            return cmd;
        } catch (_) {
            // try next
        }
    }
    return null;
}

/**
 * Print a file using Sumatra PDF (user's preferred method)
 * Falls back to PowerShell printing if Sumatra is not available
 */
async function printFile(filePath, printerName = DEFAULT_PRINTER, pageRange = null, paperSize = 'short', colorMode = 'grayscale') {
    try {
        colorMode = normalizeColorMode(colorMode);
        console.log(`Attempting to print: ${filePath} to printer: ${printerName}`);
        console.log(`Paper size: ${paperSize}, Color mode: ${colorMode}`);
        if (pageRange) {
            console.log(`Page range: ${pageRange.startPage}-${pageRange.endPage}`);
        }
        
        // Verify file exists
        if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`);
        }

        // Get absolute path for better reliability
        const absolutePath = path.resolve(filePath);
        
        // If page range is specified, create a new file with only those pages
        let printFilePath = absolutePath;
        let tempFilePath = null;
        let tempGrayscalePdfPath = null;
        
        console.log('Page range check:', { pageRange, startPage: pageRange?.startPage, endPage: pageRange?.endPage });
        
        if (pageRange && pageRange.startPage && pageRange.endPage) {
            console.log(`Creating page range file for pages ${pageRange.startPage}-${pageRange.endPage}`);
            try {
                tempFilePath = await createPageRangeFile(absolutePath, pageRange);
                if (tempFilePath) {
                    printFilePath = tempFilePath;
                    console.log(`Created page range file: ${printFilePath}`);
                }
            } catch (rangeError) {
                console.warn('Failed to create page range file, printing full document:', rangeError.message);
            }
        } else {
            console.log('No page range specified, printing full document');
        }

        if (!IS_WINDOWS && colorMode !== 'colored' && String(printFilePath || '').toLowerCase().endsWith('.pdf')) {
            try {
                const grayscalePath = await convertPdfToGrayscale(printFilePath);
                if (grayscalePath) {
                    tempGrayscalePdfPath = grayscalePath;
                    printFilePath = grayscalePath;
                    console.log(`Converted PDF to grayscale for printing: ${printFilePath}`);
                } else {
                    console.warn('Ghostscript (gs) not found; cannot force grayscale PDF conversion. Printing as-is.');
                }
            } catch (grayError) {
                console.warn('Failed to convert PDF to grayscale; printing as-is:', grayError.message);
            }
        }
        
        // Configure printer for the selected paper size BEFORE printing
        console.log(`Configuring printer for ${paperSize} paper size...`);
        const paperConfigResult = await configurePrinterPaperSize(printerName, paperSize);
        if (paperConfigResult.success) {
            console.log('Printer configured successfully for paper size');
        } else {
            console.warn('Could not configure printer for paper size:', paperConfigResult.error);
        }

        if (!IS_WINDOWS) {
            const printResult = await printWithCups(printFilePath, printerName, paperSize, colorMode);

            // Clean up temporary file if it was created
            if (tempFilePath && fs.existsSync(tempFilePath)) {
                try {
                    fs.unlinkSync(tempFilePath);
                    console.log('Cleaned up temporary page range file');
                } catch (cleanupError) {
                    console.warn('Could not clean up temp file:', cleanupError.message);
                }
            }

            if (tempGrayscalePdfPath && fs.existsSync(tempGrayscalePdfPath)) {
                try {
                    fs.unlinkSync(tempGrayscalePdfPath);
                    console.log('Cleaned up temporary grayscale PDF file');
                } catch (cleanupError) {
                    console.warn('Could not clean up grayscale temp file:', cleanupError.message);
                }
            }

            return printResult;
        }
        
        // Try multiple printing methods in order of preference
        let printResult = null;

        if (colorMode !== 'colored') {
            try {
                console.log('Attempting to print with PowerShell (preferred for grayscale)...');
                printResult = await printWithPowerShell(printFilePath, printerName, paperSize, colorMode);
                if (printResult && printResult.success) {
                    console.log('PowerShell printing successful');
                    return printResult;
                }
                console.log('PowerShell grayscale print did not succeed, trying Sumatra/Windows print...');
            } catch (psError) {
                console.log('PowerShell grayscale print failed, trying Sumatra/Windows print...', psError.message);
            }
        }
        
        // Method 1: Try Sumatra PDF first (user's preference)
        try {
            console.log('Attempting to print with Sumatra PDF...');
            printResult = await printWithSumatra(printFilePath, printerName, paperSize, colorMode);
            if (printResult.success) {
                console.log('Sumatra PDF printing successful');
                return printResult;
            }
            console.log('Sumatra failed, trying Windows print method...');
        } catch (sumatraError) {
            console.log('Sumatra not available, trying Windows print method...', sumatraError.message);
        }

        // Method 2: Try Windows print command with paper size settings
        try {
            console.log('Attempting to print with Windows print command...');
            printResult = await printWithWindowsPrint(printFilePath, printerName, paperSize, colorMode);
            if (printResult.success) {
                console.log('Windows print command successful');
                return printResult;
            }
            console.log('Windows print failed, trying PowerShell method...');
        } catch (windowsError) {
            console.log('Windows print not available, trying PowerShell method...', windowsError.message);
        }

        // Method 3: Fallback to PowerShell printing
        console.log('Attempting to print with PowerShell...');
        printResult = await printWithPowerShell(printFilePath, printerName, paperSize, colorMode);
        
        // Clean up temporary file if it was created
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            try {
                fs.unlinkSync(tempFilePath);
                console.log('Cleaned up temporary page range file');
            } catch (cleanupError) {
                console.warn('Could not clean up temp file:', cleanupError.message);
            }
        }
        
        return printResult;

    } catch (error) {
        console.error('Print error:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Print using Sumatra PDF (user's preferred method)
 */
async function printWithSumatra(filePath, printerName, paperSize, colorMode) {
    try {
        // Common Sumatra PDF installation paths
        const sumatraPaths = [
            path.join(__dirname, 'sumatra', 'SumatraPDF', 'SumatraPDF.exe'), // Local PisoPrinter installation
            'C:\\Program Files\\SumatraPDF\\SumatraPDF.exe',
            'C:\\Program Files (x86)\\SumatraPDF\\SumatraPDF.exe',
            'C:\\Users\\ADMIN\\AppData\\Local\\SumatraPDF\\SumatraPDF.exe',
            'SumatraPDF.exe' // If in PATH
        ];

        let sumatraPath = null;
        
        // Check if Sumatra is in PATH first
        try {
            await execAsync('SumatraPDF.exe -help');
            sumatraPath = 'SumatraPDF.exe';
        } catch (pathError) {
            // Check common installation paths
            for (const testPath of sumatraPaths) {
                if (fs.existsSync(testPath)) {
                    sumatraPath = testPath;
                    break;
                }
            }
        }

        if (!sumatraPath) {
            throw new Error('Sumatra PDF not found');
        }

        console.log(`Using Sumatra PDF at: ${sumatraPath}`);

        // Build print settings based on paper size and color mode
        let printSettings = ['noscale'];
        
        // Add paper size settings - use more specific settings for better paper size handling
        if (paperSize === 'long') {
            printSettings.push('fitwidth'); // For long paper, fit to width
            printSettings.push('legal'); // Explicitly specify legal size
        } else {
            printSettings.push('fitpage'); // For short paper, fit to page
            printSettings.push('letter'); // Explicitly specify letter size
        }
        
        // Add color mode settings - be more explicit for grayscale
        if (colorMode === 'colored') {
            printSettings.push('color');
        } else {
            // For grayscale, try multiple approaches
            printSettings.push('monochrome');
            printSettings.push('grayscale');
            // Some printers need explicit grayscale setting
            if (colorMode === 'grayscale') {
                printSettings.push('bw'); // black and white
            }
        }
        
        const settingsString = printSettings.join(',');
        console.log(`Print settings: ${settingsString}`);

        // Use Sumatra's silent printing feature with custom settings
        let command = `"${sumatraPath}" -print-to "${printerName}" -print-settings "${settingsString}" -silent "${filePath}"`;
        
        // For grayscale, try alternative command formats that might work better with Epson
        if (colorMode === 'grayscale') {
            // Alternative 1: Use separate arguments instead of comma-separated settings
            const altCommand1 = `"${sumatraPath}" -print-to "${printerName}" -print-settings "noscale,monochrome" -silent "${filePath}"`;
            
            // Alternative 2: Try with different grayscale keywords
            const altCommand2 = `"${sumatraPath}" -print-to "${printerName}" -print-settings "noscale,grayscale" -silent "${filePath}"`;
            
            // Alternative 3: Use minimal settings that might work better
            const altCommand3 = `"${sumatraPath}" -print-to "${printerName}" -print-settings "monochrome" -silent "${filePath}"`;
            
            console.log('Trying alternative grayscale commands:');
            console.log('  Alt 1:', altCommand1);
            console.log('  Alt 2:', altCommand2);
            console.log('  Alt 3:', altCommand3);
            
            // Try the alternative commands first for grayscale
            command = altCommand1; // Start with the most likely to work
        }
        
        console.log(`Executing Sumatra command: ${command}`);
        
        const result = await execAsync(command, { timeout: 30000 });
        
        console.log('Sumatra print command completed successfully');
        
        return {
            success: true,
            message: 'Document sent to printer via Sumatra PDF',
            method: 'sumatra',
            command: command,
            output: result.stdout || 'No output'
        };

    } catch (error) {
        console.error('Sumatra printing error:', error);
        throw new Error(`Sumatra printing failed: ${error.message}`);
    }
}

/**
 * Print using PowerShell as fallback
 */
async function printWithPowerShell(filePath, printerName, paperSize, colorMode) {
    try {
        console.log(`Using PowerShell to print: ${filePath}`);
        
        // Create a PowerShell script that handles different file types
        const scriptContent = `
# PowerShell printing script for Piso Printer
$filePath = "${filePath.replace(/\\/g, '\\\\')}"
$printerName = "${printerName}"
$paperSize = "${paperSize}"
$colorMode = "${colorMode}"

Write-Host "Printing file: $filePath"
Write-Host "Target printer: $printerName"
Write-Host "Paper size: $paperSize"
Write-Host "Color mode: $colorMode"

# Check if file exists
if (-not (Test-Path $filePath)) {
    Write-Error "File not found: $filePath"
    exit 1
}

# Get file extension
$extension = [System.IO.Path]::GetExtension($filePath).ToLower()
Write-Host "File extension: $extension"

# Set printer preferences based on paper size and color mode
try {
    # Get the printer object
    $printer = Get-Printer -Name $printerName -ErrorAction Stop
    
    # Set color mode if supported
    if ($colorMode -eq "colored") {
        try {
            Set-PrinterProperty -PrinterName $printerName -PropertyName "ColorMode" -Value "Color" -ErrorAction SilentlyContinue
            Write-Host "Set printer to color mode"
        } catch {
            Write-Host "Could not set color mode (may not be supported by this printer)"
        }
    } else {
        # For grayscale, try multiple approaches to ensure it works
        try {
            # Try the standard ColorMode property
            Set-PrinterProperty -PrinterName $printerName -PropertyName "ColorMode" -Value "Monochrome" -ErrorAction SilentlyContinue
            Write-Host "Set printer to monochrome mode via ColorMode"
        } catch {
            Write-Host "Could not set monochrome mode via ColorMode"
        }
        
        try {
            # Try alternative property names that some printers use
            Set-PrinterProperty -PrinterName $printerName -PropertyName "Color" -Value "False" -ErrorAction SilentlyContinue
            Write-Host "Set printer to grayscale via Color property"
        } catch {
            Write-Host "Could not set grayscale via Color property"
        }
        
        try {
            # Try another common property name
            Set-PrinterProperty -PrinterName $printerName -PropertyName "PrintInGrayscale" -Value "True" -ErrorAction SilentlyContinue
            Write-Host "Set printer to grayscale via PrintInGrayscale property"
        } catch {
            Write-Host "Could not set grayscale via PrintInGrayscale property"
        }
        
        try {
            # Try setting to black and white explicitly
            Set-PrinterProperty -PrinterName $printerName -PropertyName "ColorMode" -Value "BlackAndWhite" -ErrorAction SilentlyContinue
            Write-Host "Set printer to black and white mode"
        } catch {
            Write-Host "Could not set black and white mode"
        }
    }
    
    # Set paper size if supported
    if ($paperSize -eq "long") {
        try {
            # Try to set to legal or A4 size for long paper
            Set-PrinterProperty -PrinterName $printerName -PropertyName "PageMediaSize" -Value "Legal" -ErrorAction SilentlyContinue
            Write-Host "Set printer to legal size paper"
        } catch {
            try {
                Set-PrinterProperty -PrinterName $printerName -PropertyName "PageMediaSize" -Value "A4" -ErrorAction SilentlyContinue
                Write-Host "Set printer to A4 size paper"
            } catch {
                Write-Host "Could not set paper size (may not be supported by this printer)"
            }
        }
    } else {
        try {
            # Try to set to letter size for short paper
            Set-PrinterProperty -PrinterName $printerName -PropertyName "PageMediaSize" -Value "Letter" -ErrorAction SilentlyContinue
            Write-Host "Set printer to letter size paper"
        } catch {
            Write-Host "Could not set paper size (may not be supported by this printer)"
        }
    }
    
} catch {
    Write-Host "Could not configure printer settings: $_"
}

# Additional step: Try to set printer defaults for the current session
try {
    if ($colorMode -eq "grayscale") {
        # Force grayscale by setting multiple default properties
        $defaults = @{
            "ColorMode" = "Monochrome"
            "Color" = $false
            "PrintInGrayscale" = $true
        }
        
        foreach ($prop in $defaults.GetEnumerator()) {
            try {
                Set-PrinterProperty -PrinterName $printerName -PropertyName $prop.Key -Value $prop.Value -ErrorAction SilentlyContinue
                Write-Host "Set default $($prop.Key) = $($prop.Value)"
            } catch {
                Write-Host "Could not set default $($prop.Key)"
            }
        }
        
        # Epson-specific settings - try different property names that Epson printers use
        $epsonDefaults = @{
            "ColorMode" = "Monochrome"
            "ColorMode" = "Grayscale"
            "ColorMode" = "BlackAndWhite"
            "Color" = $false
            "PrintInGrayscale" = $true
            "Grayscale" = $true
            "Monochrome" = $true
            "BlackAndWhite" = $true
            "ColorMode" = "1"  # Some printers use numeric values
            "ColorMode" = "0"  # 0 = grayscale, 1 = color
        }
        
        Write-Host "Trying Epson-specific grayscale settings..."
        foreach ($prop in $epsonDefaults.GetEnumerator()) {
            try {
                Set-PrinterProperty -PrinterName $printerName -PropertyName $prop.Key -Value $prop.Value -ErrorAction SilentlyContinue
                Write-Host "Set Epson default $($prop.Key) = $($prop.Value)"
            } catch {
                Write-Host "Could not set Epson default $($prop.Key)"
            }
        }
        
        # Try to set printer preferences directly via registry if possible
        try {
            $printerPath = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Print\Printers\$printerName"
            if (Test-Path $printerPath) {
                Write-Host "Found printer registry path: $printerPath"
                # Try to set some common Epson registry values
                try {
                    Set-ItemProperty -Path $printerPath -Name "ColorMode" -Value "Monochrome" -ErrorAction SilentlyContinue
                    Write-Host "Set registry ColorMode to Monochrome"
                } catch {
                    Write-Host "Could not set registry ColorMode"
                }
            }
        } catch {
            Write-Host "Could not access printer registry: $_"
        }
        
        # Final attempt: Try to force grayscale by modifying the print job settings
        if ($colorMode -eq "grayscale") {
            try {
                Write-Host "Attempting to force grayscale at print job level..."
                
                # Try to use Windows print spooler to force grayscale
                $printJob = Get-PrintJob -PrinterName $printerName -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($printJob) {
                    Write-Host "Found print job, attempting to modify settings..."
                    try {
                        # Some printers support job-level color settings
                        Set-PrintJob -InputObject $printJob -Properties @{"ColorMode"="Monochrome"} -ErrorAction SilentlyContinue
                        Write-Host "Modified print job ColorMode to Monochrome"
                    } catch {
                        Write-Host "Could not modify print job settings: $_"
                    }
                }
            } catch {
                Write-Host "Could not access print job settings: $_"
            }
        }
        
        # Ultimate fallback: Try to use Windows print dialog with forced grayscale
        if ($colorMode -eq "grayscale") {
            try {
                Write-Host "Attempting Windows print dialog with forced grayscale..."
                
                # Create a temporary batch file to force grayscale printing
                $batchContent = @"
@echo off
echo Forcing grayscale printing for: $filePath
echo Target printer: $printerName
echo Color mode: $colorMode

REM Try to set printer to grayscale mode
rundll32 printui.dll,PrintUIEntry /Ss /n "$printerName" /a "$filePath" /r "ColorMode=Monochrome"

REM Alternative: Use start command with print verb and force grayscale
start /min "" "$filePath" /print /grayscale

echo Grayscale print job submitted
"@
                
                $batchFile = [System.IO.Path]::GetTempFileName() + ".bat"
                $batchContent | Out-File -FilePath $batchFile -Encoding ASCII
                Write-Host "Created batch file: $batchFile"
                
                # Execute the batch file
                Start-Process -FilePath $batchFile -Wait -WindowStyle Hidden
                Write-Host "Executed grayscale batch file"
                
                # Clean up
                Remove-Item $batchFile -Force -ErrorAction SilentlyContinue
                
            } catch {
                Write-Host "Could not use Windows print dialog fallback: $_"
            }
        }
} catch {
    Write-Host "Could not set printer defaults: $_"
}

try {
    if ($extension -eq ".pdf") {
        # For PDF files, try to use Adobe Reader or default PDF handler
        Write-Host "Attempting to print PDF file..."
        
        # Method 1: Try using Windows default verb
        $processInfo = New-Object System.Diagnostics.ProcessStartInfo
        $processInfo.FileName = $filePath
        $processInfo.Verb = "print"
        $processInfo.UseShellExecute = $true
        $processInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
        
        $process = [System.Diagnostics.Process]::Start($processInfo)
        if ($process) {
            $process.WaitForExit(30000)  # Wait up to 30 seconds
            Write-Host "PDF print job submitted via default handler"
        } else {
            throw "Failed to start print process"
        }
    } 
    elseif ($extension -eq ".html" -or $extension -eq ".htm") {
        # For HTML files, use Internet Explorer or Edge
        Write-Host "Attempting to print HTML file..."
        
        # Use Internet Explorer for printing HTML
        $ie = New-Object -ComObject InternetExplorer.Application
        $ie.Visible = $false
        $ie.Navigate($filePath)
        
        # Wait for page to load
        while ($ie.Busy -eq $true) {
            Start-Sleep -Milliseconds 100
        }
        
        # Print the document
        $ie.ExecWB(6, 2)  # OLECMDID_PRINT with OLECMDEXECOPT_DONTPROMPTUSER
        Start-Sleep -Seconds 2
        $ie.Quit()
        
        Write-Host "HTML print job submitted via Internet Explorer"
    }
    else {
        # For other file types, try default print verb
        Write-Host "Attempting to print using default handler..."
        
        $processInfo = New-Object System.Diagnostics.ProcessStartInfo
        $processInfo.FileName = $filePath
        $processInfo.Verb = "print"
        $processInfo.UseShellExecute = $true
        $processInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
        
        $process = [System.Diagnostics.Process]::Start($processInfo)
        if ($process) {
            $process.WaitForExit(30000)
            Write-Host "Print job submitted via default handler"
        } else {
            throw "Failed to start print process"
        }
    }
    
    Write-Host "Print command completed successfully"
    exit 0
    
} catch {
    Write-Error "Printing failed: $_"
    exit 1
}
`;

        // Save the script to a temporary file
        const scriptPath = path.join('uploads', `print_script_${Date.now()}.ps1`);
        fs.writeFileSync(scriptPath, scriptContent);

        console.log(`Created PowerShell script: ${scriptPath}`);

        // Execute the PowerShell script
        const command = `powershell -ExecutionPolicy Bypass -File "${scriptPath}"`;
        console.log(`Executing PowerShell command: ${command}`);

        const result = await execAsync(command, { timeout: 45000 });

        console.log('PowerShell print script completed');
        console.log('Output:', result.stdout);

        // Clean up the script file
        try {
            fs.unlinkSync(scriptPath);
        } catch (cleanupError) {
            console.warn('Could not clean up script file:', cleanupError.message);
        }

        return {
            success: true,
            message: 'Document sent to printer via PowerShell',
            method: 'powershell',
            output: result.stdout || 'No output',
            errors: result.stderr || 'No errors'
        };

    } catch (error) {
        console.error('PowerShell printing error:', error);
        return {
            success: false,
            error: `PowerShell printing failed: ${error.message}`,
            method: 'powershell'
        };
    }
}

/**
 * Get list of available printers
 */
async function getPrinters() {
    try {
        if (!IS_WINDOWS) {
            return await getPrintersLinux();
        }

        const command = 'powershell -Command "Get-Printer | Select-Object Name, PrinterStatus, DriverName | ConvertTo-Json"';
        const result = await execAsync(command);
        
        let printers = [];
        if (result.stdout) {
            try {
                const parsed = JSON.parse(result.stdout);
                printers = Array.isArray(parsed) ? parsed : [parsed];
            } catch (parseError) {
                console.warn('Could not parse printer list JSON:', parseError);
                printers = [];
            }
        }

        return {
            success: true,
            printers: printers
        };
    } catch (error) {
        console.error('Error getting printers:', error);
        return {
            success: false,
            error: error.message,
            printers: []
        };
    }
}

/**
 * Test printer connectivity
 */
async function testPrinter(printerName = DEFAULT_PRINTER) {
    try {
        console.log(`Testing printer: ${printerName}`);
        
        // Create a simple test file
        const testFilePath = path.join('uploads', `test_print_${Date.now()}.txt`);
        const testContent = `Piso Printer Test
=================
Date: ${new Date().toLocaleString()}
Printer: ${printerName}
Status: Test successful

This is a test document to verify printer connectivity.
If you can see this, your Epson L120 is working correctly!

End of test document.`;

        fs.writeFileSync(testFilePath, testContent);
        
        // Try to print the test file
        const printResult = await printFile(testFilePath, printerName, null, 'short', 'grayscale');
        
        // Clean up test file
        try {
            fs.unlinkSync(testFilePath);
        } catch (cleanupError) {
            console.warn('Could not clean up test file:', cleanupError.message);
        }

        return {
            success: printResult.success,
            message: printResult.success ? 'Test print sent successfully' : 'Test print failed',
            details: printResult
        };
        
    } catch (error) {
        console.error('Printer test error:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Test PowerShell execution
 */
async function testPowerShell() {
    try {
        if (!IS_WINDOWS) {
            return {
                success: false,
                error: 'PowerShell is not available on this OS',
                output: null
            };
        }

        console.log('Testing PowerShell execution...');
        
        const command = 'powershell -Command "Write-Host \'PowerShell test successful\'; Get-Date; $PSVersionTable.PSVersion"';
        const result = await execAsync(command, { timeout: 10000 });
        
        return {
            success: true,
            output: result.stdout,
            message: 'PowerShell test completed successfully'
        };
        
    } catch (error) {
        console.error('PowerShell test error:', error);
        return {
            success: false,
            error: error.message,
            output: null
        };
    }
}

/**
 * Get detailed printer status
 */
async function getDetailedPrinterStatus(printerName = DEFAULT_PRINTER) {
    try {
        if (!IS_WINDOWS) {
            const requestedPrinterName = (process.env.PRINTER_NAME || printerName || '').trim();
            const effectivePrinter = await resolveLinuxPrinterName(requestedPrinterName);
            if (!effectivePrinter) {
                return { success: false, error: 'No printers found via CUPS (lpstat -p)' };
            }

            const { stdout } = await execAsync(`lpstat -p "${effectivePrinter}" -l`);
            return {
                success: true,
                printer: {
                    name: effectivePrinter,
                    status: 'Unknown',
                    detailedStatus: (stdout || '').trim() || null,
                    portName: null,
                    driverName: null,
                    location: null,
                    totalJobsPrinted: null,
                    totalPagesPrinted: null
                }
            };
        }

        const command = `powershell -Command "Get-Printer -Name '${printerName}' | Select-Object * | ConvertTo-Json"`;
        const result = await execAsync(command);
        
        if (result.stdout) {
            try {
                const printerInfo = JSON.parse(result.stdout);
                return {
                    success: true,
                    printer: {
                        name: printerInfo.Name || printerName,
                        status: printerInfo.PrinterStatus || 'Unknown',
                        detailedStatus: printerInfo.DetailedStatus || null,
                        portName: printerInfo.PortName || null,
                        driverName: printerInfo.DriverName || null,
                        location: printerInfo.Location || null,
                        totalJobsPrinted: printerInfo.TotalJobsPrinted || 0,
                        totalPagesPrinted: printerInfo.TotalPagesPrinted || 0
                    }
                };
            } catch (parseError) {
                console.warn('Could not parse printer status JSON:', parseError);
            }
        }

        // Fallback to basic status
        return {
            success: true,
            printer: {
                name: printerName,
                status: 'Unknown',
                detailedStatus: 'Could not retrieve detailed status',
                portName: null,
                driverName: null,
                location: null,
                totalJobsPrinted: null,
                totalPagesPrinted: null
            }
        };
        
    } catch (error) {
        console.error('Error getting detailed printer status:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Check if printer is ready
 */
async function isPrinterReady(printerName = DEFAULT_PRINTER) {
    try {
        if (!IS_WINDOWS) {
            const requestedPrinterName = (process.env.PRINTER_NAME || printerName || '').trim();
            const effectivePrinter = await resolveLinuxPrinterName(requestedPrinterName);
            if (!effectivePrinter) {
                return { ready: false, reason: 'No printers found via CUPS (lpstat -p)', status: 'NotFound' };
            }

            try {
                const { stdout } = await execAsync(`lpstat -p "${effectivePrinter}"`);
                const lower = (stdout || '').toLowerCase();
                const ready = lower.includes('enabled') && (lower.includes('idle') || lower.includes('printing')) && !lower.includes('disabled');
                return {
                    ready,
                    reason: ready ? 'Printer is ready and available' : `Printer status: ${(stdout || '').trim()}`,
                    status: (stdout || '').trim()
                };
            } catch (e) {
                return {
                    ready: false,
                    reason: `Error checking printer: ${e.message}`,
                    status: 'Error'
                };
            }
        }

        const command = `powershell -Command "Get-Printer -Name '${printerName}' | Select-Object PrinterStatus"`;
        const result = await execAsync(command);
        
        if (result.stdout) {
            const status = result.stdout.trim();
            const isReady = status.includes('Normal') || status.includes('Idle') || status.includes('Ready');
            
            return {
                ready: isReady,
                reason: isReady ? 'Printer is ready and available' : `Printer status: ${status}`,
                status: status
            };
        }

        return {
            ready: false,
            reason: 'Could not determine printer status',
            status: 'Unknown'
        };
        
    } catch (error) {
        console.error('Error checking printer readiness:', error);
        return {
            ready: false,
            reason: `Error checking printer: ${error.message}`,
            status: 'Error'
        };
    }
}

/**
 * Get current printer configuration
 */
function getPrinterConfig() {
    return printerConfig;
}

/**
 * Update printer configuration
 */
function updatePrinterConfig(updates) {
    try {
        // Update the configuration object
        Object.assign(printerConfig, updates);
        DEFAULT_PRINTER = printerConfig.DEFAULT_PRINTER;
        global.DEFAULT_PRINTER = DEFAULT_PRINTER;
        
        // Write to file
        const configPath = path.join(__dirname, 'printer_config.js');
        let configContent = `// printer_config.js - Printer configuration settings
// This file stores printer settings that can be modified through the admin panel

module.exports = ${JSON.stringify(printerConfig, null, 4)};`;
        
        fs.writeFileSync(configPath, configContent);
        
        return { success: true, message: 'Printer configuration updated successfully' };
    } catch (error) {
        console.error('Error updating printer configuration:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Set default printer
 */
function setDefaultPrinter(printerName) {
    try {
        const result = updatePrinterConfig({ DEFAULT_PRINTER: printerName });
        if (result.success) {
            // Update the global DEFAULT_PRINTER variable
            global.DEFAULT_PRINTER = printerName;
        }
        return result;
    } catch (error) {
        console.error('Error setting default printer:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Get available printers and update configuration
 */
async function refreshAvailablePrinters() {
    try {
        const printersResult = await getPrinters();
        if (printersResult.success) {
            const printerNames = printersResult.printers.map(p => p.Name);
            const updates = { AVAILABLE_PRINTERS: printerNames };

            if (!IS_WINDOWS) {
                const currentDefault = (printerConfig && printerConfig.DEFAULT_PRINTER) ? String(printerConfig.DEFAULT_PRINTER).trim() : '';
                const hasCurrentDefault = !!currentDefault && printerNames.includes(currentDefault);

                if (!hasCurrentDefault && printerNames.length > 0) {
                    let nextDefault = '';
                    try {
                        const { stdout } = await execAsync('lpstat -d');
                        const m = (stdout || '').match(/system default destination:\s*(\S+)/i);
                        if (m && m[1] && printerNames.includes(m[1])) {
                            nextDefault = m[1];
                        }
                    } catch (_) {}

                    if (!nextDefault && printerNames.length === 1) {
                        nextDefault = printerNames[0];
                    }

                    if (nextDefault) {
                        updates.DEFAULT_PRINTER = nextDefault;
                        updates.DEFAULTS = {
                            ...(printerConfig.DEFAULTS || {}),
                            printerName: nextDefault
                        };
                        global.DEFAULT_PRINTER = nextDefault;
                    }
                }
            }

            updatePrinterConfig(updates);
            return { success: true, printers: printerNames, defaultPrinter: updates.DEFAULT_PRINTER || (printerConfig && printerConfig.DEFAULT_PRINTER) || null };
        }
        return printersResult;
    } catch (error) {
        console.error('Error refreshing available printers:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Test printer configuration
 */
async function testPrinterConfiguration(printerName, paperSize, colorMode) {
    try {
        console.log(`Testing printer configuration: ${printerName}, ${paperSize}, ${colorMode}`);
        
        // Configure printer
        const configResult = await configurePrinterPaperSize(printerName, paperSize);
        if (!configResult.success) {
            return configResult;
        }
        
        // Test print
        const testResult = await testPrinter(printerName);
        return testResult;
    } catch (error) {
        console.error('Error testing printer configuration:', error);
        return { success: false, error: error.message };
    }
}

module.exports = {
    printFile,
    getPrinters,
    testPrinter,
    testPowerShell,
    getDetailedPrinterStatus,
    isPrinterReady,
    configurePrinterPaperSize,
    createPrintJobWithPaperSize,
    printWithWindowsPrint,
    getPrinterConfig,
    updatePrinterConfig,
    setDefaultPrinter,
    refreshAvailablePrinters,
    testPrinterConfiguration
};
