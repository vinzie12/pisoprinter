// printer_config.js - Printer configuration settings
// This file stores printer settings that can be modified through the admin panel

module.exports = {
    "DEFAULT_PRINTER": "EPSON L3150 Series",
    "AVAILABLE_PRINTERS": [
        "OneNote (Desktop)",
        "Microsoft Print to PDF",
        "EPSON L5290 Series FAX (FAX)",
        "EPSON L5290 Series",
        "EPSON L120 Series"
    ],
    "PAPER_SIZES": {
        "short": {
            "name": "Letter",
            "width": 8.5,
            "height": 11,
            "mmWidth": 216,
            "mmHeight": 279,
            "tray": "Auto",
            "driverSettings": {
                "PageMediaSize": "Letter",
                "PageMediaType": "Plain",
                "PageOrientation": "Portrait"
            }
        },
        "long": {
            "name": "Legal",
            "width": 8.5,
            "height": 14,
            "mmWidth": 216,
            "mmHeight": 356,
            "tray": "Auto",
            "driverSettings": {
                "PageMediaSize": "Legal",
                "PageMediaType": "Plain",
                "PageOrientation": "Portrait"
            }
        }
    },
    "COLOR_MODES": {
        "grayscale": {
            "name": "Grayscale",
            "description": "Print in black and white",
            "settings": {
                "ColorMode": "Monochrome",
                "Color": false,
                "PrintInGrayscale": true
            }
        },
        "colored": {
            "name": "Color",
            "description": "Print in full color",
            "settings": {
                "ColorMode": "Color",
                "Color": true,
                "PrintInGrayscale": false
            }
        }
    },
    "DEFAULTS": {
        "paperSize": "short",
        "colorMode": "grayscale",
        "printerName": "EPSON L3150 Series"
    },
    "PRINTER_SETTINGS": {
        "EPSON L120 Series": {
            "name": "EPSON L120 Series",
            "type": "Inkjet",
            "supportedPaperSizes": [
                "short",
                "long"
            ],
            "supportedColorModes": [
                "grayscale",
                "colored"
            ],
            "specialSettings": {
                "PageMediaSize": "Letter",
                "PageMediaType": "Plain",
                "PageOrientation": "Portrait"
            }
        },
        "EPSON L3150 Series": {
            "name": "EPSON L3150 Series",
            "type": "Inkjet",
            "supportedPaperSizes": [
                "short",
                "long"
            ],
            "supportedColorModes": [
                "grayscale",
                "colored"
            ],
            "specialSettings": {
                "PageMediaSize": "Letter",
                "PageMediaType": "Plain",
                "PageOrientation": "Portrait"
            }
        }
    },
    "PRINT_QUALITY": {
        "draft": {
            "name": "Draft",
            "description": "Fast printing, lower quality",
            "settings": {
                "PrintQuality": "Draft",
                "Resolution": "300"
            }
        },
        "normal": {
            "name": "Normal",
            "description": "Balanced speed and quality",
            "settings": {
                "PrintQuality": "Normal",
                "Resolution": "600"
            }
        },
        "high": {
            "name": "High",
            "description": "Best quality, slower printing",
            "settings": {
                "PrintQuality": "High",
                "Resolution": "1200"
            }
        }
    },
    "DEFAULT_PRINT_QUALITY": "normal",
    "AUTO_REFRESH": {
        "enabled": true,
        "interval": 30000,
        "refreshPrinterList": true
    },
    "TEST_PRINT": {
        "enabled": true,
        "autoCleanup": true,
        "cleanupAfterMinutes": 5
    }
};