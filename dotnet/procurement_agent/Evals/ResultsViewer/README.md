# Agent365 Evaluation Results Viewer

An interactive web-based viewer for Agent365 evaluation results that provides detailed analysis, filtering, and visualization of test outcomes.

## Overview

The Results Viewer is a shared component used by both 1P (LocalEvalRunner) and 3P (Direct GPT) evaluation frameworks to provide a unified way to view and analyze test results. It automatically aggregates results from the `../reports/` directory and presents them in an easy-to-navigate web interface.

## Features

### 📊 Interactive Dashboard
- **Summary Statistics**: Pass/fail rates, total tests, and performance metrics
- **Real-time Filtering**: Filter by test status, scenario files, or search terms
- **Detailed Test Views**: Expand individual tests to see full context and results

### 🎯 Test Analysis
- **Pass/Fail Indicators**: Clear visual status for each test
- **Execution Details**: View agent responses, expected outcomes, and evaluation rationale
- **Performance Tracking**: Response times and execution metadata
- **Error Analysis**: Detailed failure information and debugging context

### 🔍 Navigation & Search
- **Scenario Grouping**: Tests organized by scenario files (basic, comprehensive, email, dataverse)
- **Search Functionality**: Find specific tests by name, description, or content
- **Status Filtering**: Show only passed, failed, or all tests
- **Responsive Design**: Works on desktop and mobile devices

## File Structure

```
ResultsViewer/
├── README.md                    # This documentation
├── Generate-ResultsViewer.ps1   # PowerShell script to generate viewer
├── template.html                # HTML template for the viewer
├── styles.css                   # CSS styling
├── script.js                    # JavaScript functionality
└── index.html                   # Generated viewer (auto-created)
```

## Usage

### Automatic Generation
Both evaluation scripts automatically generate and open the results viewer:

**1P Evaluation (LocalEvalRunner):**
```powershell
.\run-evaluation.ps1 -TestFile "agent365_basic_tests.json"
# Results viewer opens automatically
```

**3P Evaluation (Direct GPT):**
```powershell
.\run-evaluation.ps1 -TestFile "agent365_basic_tests.json"
# Results viewer opens automatically
```

### Manual Generation
You can also generate the viewer manually:

```powershell
# From the ResultsViewer directory
.\Generate-ResultsViewer.ps1

# Force regenerate and open
.\Generate-ResultsViewer.ps1 -Force -Open

# Just regenerate without opening
.\Generate-ResultsViewer.ps1 -Force
```

### Direct Access
Open the generated viewer directly:
```powershell
# Windows
start .\index.html

# Or navigate to file in browser
# file:///C:/repos/Agent365/dotnet/samples/hello_world_a365_agent/Evals/ResultsViewer/index.html
```

## Report Format

The viewer reads JSON reports from `../reports/` with this structure:

```json
{
    "metadata": {
        "timestamp": "2024-10-02T15:30:45Z",
        "scenarioFile": "agent365_basic_tests.json",
        "totalTests": 6,
        "passedTests": 4,
        "failedTests": 2,
        "passRate": 66.67,
        "evaluationType": "3P"
    },
    "results": [
        {
            "testId": "test_001",
            "testName": "Basic Agent Response",
            "description": "Test agent's ability to respond to simple queries",
            "status": "PASSED",
            "agentResponse": "Hello! I'm here to help...",
            "expectedOutcome": "Agent should respond helpfully",
            "evaluationRationale": "Response is helpful and appropriate",
            "executionTimeMs": 1234,
            "timestamp": "2024-10-02T15:30:45Z"
        }
    ]
}
```

## Features in Detail

### Dashboard Overview
- **Pass Rate Visualization**: Color-coded progress bars and percentages
- **Test Distribution**: Breakdown by scenario files
- **Recent Results**: Timestamp-based organization of evaluation runs

### Test Details
Each test result includes:
- **Status Badge**: Clear pass/fail indicators with color coding
- **Test Metadata**: ID, name, description, and execution time
- **Agent Response**: Full response from the agent being evaluated
- **Expected Outcome**: What the test was designed to verify
- **Evaluation Rationale**: Detailed explanation of why the test passed or failed
- **Timestamp**: When the test was executed

### Filtering & Search
- **Status Filter**: Show all, passed only, or failed only tests
- **Text Search**: Search across test names, descriptions, responses, and rationales
- **Scenario Filter**: Filter by specific scenario files
- **Real-time Updates**: Filters apply immediately as you type

## Customization

### Styling
Modify `styles.css` to customize the appearance:
- Color schemes for pass/fail indicators
- Layout and spacing
- Typography and fonts
- Responsive breakpoints

### Functionality
Extend `script.js` to add features:
- Additional filtering options
- Export functionality
- Performance charts
- Comparison views

### Template
Update `template.html` to modify the structure:
- Add new sections
- Rearrange layout
- Include additional metadata

## Browser Compatibility

The Results Viewer works with modern web browsers:
- ✅ Chrome 80+
- ✅ Firefox 75+
- ✅ Safari 13+
- ✅ Edge 80+

## Troubleshooting

### Common Issues

**Viewer doesn't open automatically:**
- Check that `Generate-ResultsViewer.ps1` exists and is executable
- Verify the evaluation script has the results viewer code section
- Run manually: `.\Generate-ResultsViewer.ps1 -Force -Open`

**No results showing:**
- Ensure reports exist in `../reports/` directory
- Check that JSON files are valid (use `Test-Json` in PowerShell)
- Verify report file naming follows the expected pattern

**Viewer shows old results:**
- Use `-Force` parameter to regenerate: `.\Generate-ResultsViewer.ps1 -Force`
- Clear browser cache if viewing cached version

**JavaScript errors:**
- Check browser console for specific error messages
- Ensure all files (script.js, styles.css) are present
- Verify JSON report format is correct

### Debug Mode
Enable detailed logging in the generation script:
```powershell
.\Generate-ResultsViewer.ps1 -Force -Open -Verbose
```

## Integration

The Results Viewer integrates seamlessly with both evaluation frameworks:

1. **Shared Location**: Located in common `Evals/ResultsViewer/` directory
2. **Unified Reports**: Both 1P and 3P evaluations write to the same reports format
3. **Automatic Generation**: Both evaluation scripts include results viewer automation
4. **Cross-Platform**: Works on Windows, macOS, and Linux with PowerShell Core

## Contributing

When modifying the Results Viewer:

1. **Test Both Frameworks**: Ensure changes work with both 1P and 3P evaluations
2. **Preserve Compatibility**: Maintain backward compatibility with existing report formats
3. **Update Documentation**: Keep this README current with any changes
4. **Cross-Platform Testing**: Verify functionality on different operating systems

## Version History

- **v1.0**: Initial implementation for 1P evaluations
- **v1.1**: Extended for 3P evaluation support and moved to shared location
- **v1.2**: Added filtering, search, and enhanced UI features
- **v1.3**: Current version with automatic generation and opening

---

For more information about the Agent365 evaluation framework, see the main [Evals README](../README.md).