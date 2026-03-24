// Helper function to escape HTML special characters
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Helper function to safely render agent response that may contain HTML
function renderAgentResponse(responseText) {
    if (!responseText) return '';
    
    // First, check if the response contains HTML tags
    const hasHtmlTags = /<[^>]*>/g.test(responseText);
    
    if (hasHtmlTags) {
        // If it contains HTML, render it as HTML but sanitize dangerous elements
        return sanitizeHtml(responseText);
    } else {
        // If it's plain text, convert newlines to <br> and escape HTML entities
        return responseText
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\n/g, '<br>');
    }
}

// Basic HTML sanitization to prevent XSS while allowing safe formatting
function sanitizeHtml(html) {
    // Allow safe HTML tags for formatting
    const allowedTags = ['br', 'p', 'div', 'span', 'strong', 'b', 'em', 'i', 'u', 'code', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote'];
    
    // Create a temporary div to parse the HTML
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = html;
    
    // Remove any script tags and event handlers
    tempDiv.querySelectorAll('script').forEach(el => el.remove());
    tempDiv.querySelectorAll('*').forEach(el => {
        // Remove event handler attributes
        Array.from(el.attributes).forEach(attr => {
            if (attr.name.startsWith('on')) {
                el.removeAttribute(attr.name);
            }
        });
        
        // Remove elements that are not in the allowed list
        if (!allowedTags.includes(el.tagName.toLowerCase())) {
            // Replace with text content
            const textNode = document.createTextNode(el.textContent);
            el.parentNode?.replaceChild(textNode, el);
        }
    });
    
    return tempDiv.innerHTML;
}

// Format duration for display
function formatDuration(durationStr) {
    if (!durationStr) return 'N/A';
    
    // Parse TimeSpan format (e.g., "00:00:06.3721978")
    const match = durationStr.match(/(\d{2}):(\d{2}):(\d{2})\.(\d+)/);
    if (match) {
        const hours = parseInt(match[1]);
        const minutes = parseInt(match[2]);
        const seconds = parseInt(match[3]);
        const milliseconds = Math.round(parseInt(match[4]) / 10000); // Convert to milliseconds
        
        if (hours > 0) {
            return `${hours}h ${minutes}m ${seconds}s`;
        } else if (minutes > 0) {
            return `${minutes}m ${seconds}s`;
        } else if (seconds > 0) {
            return `${seconds}.${Math.floor(milliseconds/100)}s`;
        } else {
            return `${milliseconds}ms`;
        }
    }
    
    return durationStr;
}

// Format date for display
function formatDate(dateStr) {
    if (!dateStr) return 'N/A';
    
    try {
        const date = new Date(dateStr);
        return date.toLocaleString();
    } catch (e) {
        return dateStr;
    }
}

// Calculate overall score from evaluation results
function calculateOverallScore(test) {
    // Check if overallScore is already calculated
    if (test.overallScore !== undefined && test.overallScore !== null) {
        return test.overallScore.toFixed(2);
    }
    
    // Fall back to calculating from evaluation results
    const evaluationResults = test.evaluationResults || test.evaluatorResults;
    
    if (!evaluationResults || evaluationResults.length === 0) {
        return '0.00';
    }
    
    let totalScore = 0;
    let validScores = 0;
    
    for (const result of evaluationResults) {
        if (result.score !== undefined && result.score !== null) {
            totalScore += result.score;
            validScores++;
        }
    }
    
    if (validScores === 0) {
        return '0.00';
    }
    
    const averageScore = totalScore / validScores;
    return averageScore.toFixed(2);
}

/*FILE_LIST_DATA_PLACEHOLDER*/

let allEvaluationFiles = [];
let currentData = null;

// Load all evaluation files on page load
async function loadEvaluationFiles() {
    try {
        // Use the embedded data instead of fetch
        const fileList = EMBEDDED_DATA;
        
        const select = document.getElementById('fileSelect');
        select.innerHTML = '<option value="">-- Select a report --</option>';
        
        fileList.files.forEach(file => {
            const option = document.createElement('option');
            option.value = file;
            option.textContent = file;
            select.appendChild(option);
        });
        
        // Auto-select the most recent file
        if (fileList.files.length > 0) {
            select.value = fileList.files[0];
            loadSelectedFile();
        }
    } catch (error) {
        console.error('Error loading file list:', error);
        document.getElementById('content').innerHTML = `
            <div class="no-results">
                ❌ Could not load evaluation files. The embedded data may be missing.
                <br><br>
                <small>Error: ${error.message}</small>
            </div>
        `;
    }
}

// Load the selected evaluation file using embedded data
async function loadSelectedFile() {
    const select = document.getElementById('fileSelect');
    const selectedFile = select.value;
    
    if (!selectedFile) {
        document.getElementById('content').innerHTML = `
            <div class="loading">
                📊 Select an evaluation report to view results
            </div>
        `;
        document.getElementById('fileInfo').style.display = 'none';
        return;
    }
    
    try {
        // Get data from embedded data
        const data = EMBEDDED_DATA.evaluationData[selectedFile];
        
        if (!data) {
            throw new Error('Report data not found in embedded data');
        }
        
        currentData = data;
        renderResults(data, selectedFile);
        
        // Show file info
        const fileInfo = document.getElementById('fileInfo');
        fileInfo.innerHTML = `
            📅 Generated: ${formatDate(data.generatedAt)} | 
            📊 Tests: ${data.summary.totalTests} | 
            ✅ Passed: ${data.summary.passedTests} | 
            ❌ Failed: ${data.summary.failedTests}
        `;
        fileInfo.style.display = 'block';
        
    } catch (error) {
        console.error('Error loading evaluation file:', error);
        document.getElementById('content').innerHTML = `
            <div class="no-results">
                ❌ Could not load evaluation file: ${escapeHtml(selectedFile)}
                <br><br>
                <small>Error: ${escapeHtml(error.message)}</small>
            </div>
        `;
        document.getElementById('fileInfo').style.display = 'none';
    }
}

// Render evaluation results
function renderResults(data, fileName) {
    const content = document.getElementById('content');
    
    // Render summary
    const summaryHtml = renderSummary(data.summary);
    
    // Render test results
    const testResultsHtml = renderTestResults(data.testResults);
    
    content.innerHTML = `
        <div class="results-header">
            <h2>📊 Evaluation Summary</h2>
        </div>
        ${summaryHtml}
        
        <div class="test-results">
            <h2>🧪 Test Results</h2>
            ${testResultsHtml}
        </div>
    `;
}

// Render summary dashboard
function renderSummary(summary) {
    const passRate = Math.round(summary.passRate * 100);
    
    return `
        <div class="summary">
            <div class="summary-card">
                <h3>Total Tests</h3>
                <div class="value">${summary.totalTests}</div>
                <div class="subtitle">Executed</div>
            </div>
            
            <div class="summary-card">
                <h3>Passed</h3>
                <div class="value">${summary.passedTests}</div>
                <div class="subtitle">${passRate}% success rate</div>
            </div>
            
            <div class="summary-card ${summary.failedTests > 0 ? 'failed' : ''}">
                <h3>Failed</h3>
                <div class="value">${summary.failedTests}</div>
                <div class="subtitle">Test failures</div>
            </div>
            
            <div class="summary-card ${summary.errorTests > 0 ? 'warning' : 'info'}">
                <h3>Errors</h3>
                <div class="value">${summary.errorTests}</div>
                <div class="subtitle">Execution errors</div>
            </div>
        </div>
    `;
}

// Render test results
function renderTestResults(testResults) {
    return testResults.map(test => {
        const statusClass = test.isError ? 'error' : (test.passed ? 'passed' : 'failed');
        const statusText = test.isError ? 'ERROR' : (test.passed ? 'PASSED' : 'FAILED');
        
        return `
            <div class="test-item">
                <div class="test-header ${statusClass}" onclick="toggleTestDetails('${test.testId}')">
                    <div class="test-title">
                        <h3>${escapeHtml(test.originalTest?.description || test.testId)}</h3>
                        <div class="test-id">${test.testId}</div>
                        ${test.category ? `<span class="badge badge-category">${test.category}</span>` : ''}
                    </div>
                    <div class="test-status">
                        <div class="response-time">${formatDuration(test.responseTime)}</div>
                        <span class="status-badge ${statusClass}">${statusText}</span>
                        <span class="expand-icon">▼</span>
                    </div>
                </div>
                
                <div class="test-details" id="details-${test.testId}">
                    ${renderTestDetails(test)}
                </div>
            </div>
        `;
    }).join('');
}

// Render detailed test information
function renderTestDetails(test) {
    let html = '';
    
    // Prompt section
    html += `
        <div class="detail-section">
            <h4>💬 Prompt</h4>
            <div class="detail-content prompt-text">${escapeHtml(test.prompt)}</div>
        </div>
    `;
    
    // Expected response
    if (test.expectedResponse) {
        html += `
            <div class="detail-section">
                <h4>✅ Expected Response</h4>
                <div class="detail-content expected-response response-text">${renderAgentResponse(test.expectedResponse)}</div>
            </div>
        `;
    }
    
    // Actual response
    html += `
        <div class="detail-section">
            <h4>🤖 Actual Response</h4>
            <div class="detail-content actual-response response-text">${renderAgentResponse(test.actualResponse)}</div>
        </div>
    `;
    
    // Error message (if any)
    if (test.errorMessage) {
        html += `
            <div class="detail-section">
                <h4>❌ Error Message</h4>
                <div class="detail-content error-message">${escapeHtml(test.errorMessage)}</div>
            </div>
        `;
    }
    
    // Function calls
    let functionCalls = test.functionCalls;
    // Normalize functionCalls to always be an array
    if (functionCalls && !Array.isArray(functionCalls)) {
        functionCalls = [functionCalls];
    }
    
    if (functionCalls && functionCalls.length > 0) {
        html += `
            <div class="detail-section">
                <h4>🔧 Function Calls</h4>
                <div class="function-calls">
                    ${functionCalls.map(call => `
                        <div class="function-call">
                            <h5>${escapeHtml(call.fullFunctionName || call.functionName || call.name || 'Unknown Function')}</h5>
                            ${call.pluginName ? `<div class="plugin-name">Plugin: ${escapeHtml(call.pluginName)}</div>` : ''}
                            <div class="function-args">${escapeHtml(JSON.stringify(call.inputParameters || call.arguments || {}, null, 2))}</div>
                            ${call.outputResult ? `<div class="function-result"><strong>Result:</strong> ${escapeHtml(call.outputResult)}</div>` : ''}
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }
    
    // Evaluation results (if any) - supports both 1P and 3P formats
    const evaluationResults = test.evaluationResults || test.evaluatorResults;
    if (evaluationResults && evaluationResults.length > 0) {
        html += `
            <div class="detail-section">
                <h4>📋 Evaluation Results</h4>
                <div class="evaluation-results">
                    ${evaluationResults.map(result => `
                        <div class="evaluation-item ${result.passed ? 'passed' : 'failed'}">
                            <div class="evaluator-header">
                                <div class="evaluator-name">${result.evaluatorName || result.criterion || 'Assertion'}</div>
                                <div class="evaluator-status ${result.passed ? 'passed' : 'failed'}">
                                    ${result.passed ? 'Passed' : 'Failed'}
                                </div>
                            </div>
                            <div class="evaluator-details">
                                <div class="score-info">
                                    <div class="score-item">Score: <span class="score-value">${result.score ? result.score.toFixed(2) : 'N/A'}</span></div>
                                    ${result.passingScore ? `<div class="score-item">Threshold: <span class="score-value">${result.passingScore}</span></div>` : ''}
                                </div>
                                ${result.feedback || result.reasoning ? `
                                    <div class="reasoning">
                                        <div class="reasoning-label">Reasoning</div>
                                        <div class="reasoning-text">${escapeHtml(result.feedback || result.reasoning)}</div>
                                    </div>
                                ` : ''}
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }
    
    // Test metadata
    html += `
        <div class="detail-section">
            <h4>ℹ️ Test Information</h4>
            <div class="detail-content">
                <strong>Test ID:</strong> ${escapeHtml(test.testId)}<br>
                <strong>Category:</strong> ${escapeHtml(test.category || 'N/A')}<br>
                <strong>Executed At:</strong> ${formatDate(test.executedAt)}<br>
                <strong>Response Time:</strong> ${formatDuration(test.responseTime)}<br>
                <strong>Overall Score:</strong> ${calculateOverallScore(test)}
            </div>
        </div>
    `;
    
    return html;
}

// Toggle test details visibility
function toggleTestDetails(testId) {
    const details = document.getElementById(`details-${testId}`);
    const header = details.previousElementSibling;
    
    if (details.classList.contains('expanded')) {
        details.classList.remove('expanded');
        header.classList.remove('expanded');
    } else {
        details.classList.add('expanded');
        header.classList.add('expanded');
    }
}

// Initialize when page loads
document.addEventListener('DOMContentLoaded', () => {
    loadEvaluationFiles();
});

// Add keyboard support for accessibility
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        // Close all expanded test details
        document.querySelectorAll('.test-details.expanded').forEach(detail => {
            detail.classList.remove('expanded');
            detail.previousElementSibling.classList.remove('expanded');
        });
    }
});