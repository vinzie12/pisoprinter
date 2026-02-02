// Table Logs Functions
function getAuthHeaders() {
    const token = localStorage.getItem('adminToken');
    return {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
    };
}

function logout() {
    localStorage.removeItem('adminToken');
    localStorage.removeItem('adminUsername');
    localStorage.removeItem('adminRole');
    localStorage.removeItem('adminPermissions');
    window.location.href = '/login.html';
}

function showTableLogs() {
    const modal = document.getElementById('tableLogsModal');
    if (!modal) {
        console.error('Table logs modal not found');
        return;
    }
    
    modal.style.display = 'block';
    
    // Wait for modal content to be ready, then set up and load data
    setTimeout(() => {
        // Set default date range
        const today = new Date().toISOString().split('T')[0];
        const dateFromInput = document.getElementById('logsDateFrom');
        const dateToInput = document.getElementById('logsDateTo');
        
        if (dateFromInput && dateToInput) {
            dateFromInput.value = today;
            dateToInput.value = today;
            
            // Load logs for today
            loadTableLogs();
        } else {
            console.error('Date inputs not found in modal');
            // Retry after a short delay
            setTimeout(() => {
                const retryDateFrom = document.getElementById('logsDateFrom');
                const retryDateTo = document.getElementById('logsDateTo');
                if (retryDateFrom && retryDateTo) {
                    retryDateFrom.value = today;
                    retryDateTo.value = today;
                    loadTableLogs();
                }
            }, 500);
        }
    }, 100);
}

function closeTableLogsModal() {
    document.getElementById('tableLogsModal').style.display = 'none';
}

async function loadTableLogs() {
    const dateFrom = document.getElementById('logsDateFrom').value;
    const dateTo = document.getElementById('logsDateTo').value;
    
    if (!dateFrom || !dateTo) {
        alert('Please select both start and end dates');
        return;
    }
    
    try {
        // Get both print transactions and coin data
        const [logsResponse, coinsResponse] = await Promise.all([
            fetch(`/api/admin/table-logs?dateFrom=${dateFrom}&dateTo=${dateTo}`, {
                headers: getAuthHeaders()
            }),
            fetch(`/api/admin/daily-coins?dateFrom=${dateFrom}&dateTo=${dateTo}`, {
                headers: getAuthHeaders()
            })
        ]);
        
        if (logsResponse.status === 401 || coinsResponse.status === 401) {
            logout();
            return;
        }
        
        const logsData = await logsResponse.json();
        const coinsData = await coinsResponse.json();
        
        if (logsData.success && coinsData.success) {
            // Calculate totals from coin data for coin count
            let totalCoins = 0;
            
            coinsData.coins.forEach(coin => {
                totalCoins += coin.count || 0;
            });
            
            // Calculate revenue from actual transaction payments (more accurate than coin data)
            const totalRevenue = logsData.logs.reduce((sum, log) => sum + (log.coins_used || 0), 0);
            
            // Create summary with correct totals
            const summary = {
                total_transactions: logsData.logs.length,
                successful_transactions: logsData.logs.filter(log => log.success).length,
                failed_transactions: logsData.logs.filter(log => !log.success).length,
                total_revenue: totalRevenue, // Use transaction payment total, more accurate than coin data
                total_coins: totalCoins
            };
            
            displayTableLogs(logsData.logs);
            updateLogsSummary(summary);
        } else {
            document.getElementById('logsTableBody').innerHTML = 
                '<tr><td colspan="7" style="padding: 40px; text-align: center; color: #dc3545;">Error loading logs: ' + (logsData.error || coinsData.error) + '</td></tr>';
        }
    } catch (error) {
        console.error('Error loading table logs:', error);
        document.getElementById('logsTableBody').innerHTML = 
            '<tr><td colspan="7" style="padding: 40px; text-align: center; color: #dc3545;">Failed to load logs</td></tr>';
    }
}

function displayTableLogs(logs) {
    const tbody = document.getElementById('logsTableBody');
    
    if (!logs || logs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="padding: 40px; text-align: center; color: #666;">No logs found for the selected date range</td></tr>';
        return;
    }
    
    tbody.innerHTML = logs.map(log => {
        const date = new Date(log.timestamp);
        const dateStr = date.toLocaleDateString();
        const timeStr = date.toLocaleTimeString();
        const statusClass = log.success ? 'success' : 'failed';
        const statusText = log.success ? '✅ Success' : '❌ Failed';
        
        return `
            <tr style="border-bottom: 1px solid #e9ecef;">
                <td style="padding: 12px; border-right: 1px solid #e9ecef;">
                    <div style="font-weight: 600;">${dateStr}</div>
                    <div style="font-size: 0.8rem; color: #666;">${timeStr}</div>
                </td>
                <td style="padding: 12px; border-right: 1px solid #e9ecef;">
                    <div style="font-weight: 500; word-break: break-word;">${log.filename}</div>
                    <div style="font-size: 0.8rem; color: #666;">${log.paper_size} • ${log.color_mode}</div>
                </td>
                <td style="padding: 12px; text-align: center; border-right: 1px solid #e9ecef;">
                    <span style="background: #f8f9fa; padding: 4px 8px; border-radius: 4px; font-weight: 600;">${log.pages_printed}</span>
                </td>
                <td style="padding: 12px; text-align: center; border-right: 1px solid #e9ecef;">
                    <span style="color: ${log.success ? '#28a745' : '#dc3545'}; font-weight: 600;">${statusText}</span>
                </td>
                <td style="padding: 12px; text-align: right; border-right: 1px solid #e9ecef;">
                    <span style="font-weight: 600; color: #1e3c72;">₱${log.total_cost}</span>
                </td>
                <td style="padding: 12px; text-align: right; border-right: 1px solid #e9ecef;">
                    <span style="font-weight: 600; color: #28a745;">₱${log.coins_used}</span>
                </td>
                <td style="padding: 12px; text-align: right;">
                    <span style="font-weight: 600; color: #ffc107;">₱${log.change_given}</span>
                </td>
            </tr>
        `;
    }).join('');
}

function updateLogsSummary(summary) {
    document.getElementById('totalTransactions').textContent = summary.total_transactions || 0;
    document.getElementById('successfulTransactions').textContent = summary.successful_transactions || 0;
    document.getElementById('failedTransactions').textContent = summary.failed_transactions || 0;
    document.getElementById('totalRevenue').textContent = `₱${summary.total_revenue || 0}`;
}

function refreshLogs() {
    loadTableLogs();
}

function exportLogs() {
    const dateFrom = document.getElementById('logsDateFrom').value;
    const dateTo = document.getElementById('logsDateTo').value;
    
    if (!dateFrom || !dateTo) {
        alert('Please select both start and end dates');
        return;
    }
    
    // Create CSV content
    const table = document.querySelector('.logs-table');
    const rows = Array.from(table.querySelectorAll('tr'));
    
    let csvContent = 'Date,Time,Filename,Pages,Status,Total Cost,Payment Made,Change\n';
    
    rows.forEach((row, index) => {
        if (index === 0) return; // Skip header
        
        const cells = Array.from(row.querySelectorAll('td'));
        if (cells.length >= 7) {
            const dateTime = cells[0].textContent.trim().split('\n');
            const filename = cells[1].textContent.trim().split('\n')[0];
            const pages = cells[2].textContent.trim();
            const status = cells[3].textContent.trim();
            const totalCost = cells[4].textContent.trim();
            const paymentMade = cells[5].textContent.trim();
            const change = cells[6].textContent.trim();
            
            csvContent += `"${dateTime[0]}","${dateTime[1]}","${filename}","${pages}","${status}","${totalCost}","${paymentMade}","${change}"\n`;
        }
    });
    
    // Download CSV
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `table-logs-${dateFrom}-to-${dateTo}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
