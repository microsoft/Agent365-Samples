# Agent365 Evaluation Scenarios

This folder contains shared test scenarios used by both 1P (LocalEvalRunner) and 3P (Direct GPT) evaluation frameworks.

## Available Test Files

### `agent365_basic_tests.json`
- **Tests**: 6 core scenarios
- **Categories**: General capabilities, email assistance, calendar management, document search, Teams collaboration, safety compliance
- **Use Case**: Quick evaluation runs and basic functionality testing
- **Recommended for**: Daily testing, CI/CD validation

### `agent365_comprehensive_tests.json`
- **Tests**: 12 comprehensive scenarios  
- **Categories**: All basic tests plus document creation, SharePoint collaboration, file search, Teams meetings, privacy/security, integration capabilities
- **Use Case**: Complete evaluation coverage and thorough testing
- **Recommended for**: Release validation, comprehensive assessment

### `agent365_email_tests.json`
- **Tests**: 3 email-focused scenarios
- **Categories**: Email plugin functionality, Send_Email tool validation
- **Use Case**: Targeted email capability testing
- **Recommended for**: Email plugin validation, communication features testing

## Test Structure

Each test file contains:
- `enabled_evaluators`: Evaluation criteria and thresholds
- `tests`: Array of test scenarios with:
  - `test_id`: Unique identifier
  - `prompt`: User input to test
  - `expected_response`: Expected agent response
  - `category`: Test category for reporting
  - `description`: Human-readable description
  - `assertions`: Validation criteria

## Usage

### 1P Evaluation (LocalEvalRunner)
```powershell
.\run-evaluation.ps1 -TestFile "agent365_basic_tests.json"
```

### 3P Evaluation (Direct GPT)
```powershell
.\run-evaluation.ps1 -TestFile "agent365_comprehensive_tests.json"
```

## Adding New Tests

1. Follow the existing JSON structure
2. Use descriptive `test_id` values with category prefixes
3. Include realistic prompts and expected responses
4. Add appropriate assertions for validation
5. Test both evaluation frameworks to ensure compatibility

## Evaluation Criteria

- **SimilarityEvaluator**: Semantic similarity between expected and actual responses (threshold: 0.7)
- **QualityEvaluator**: Overall response quality assessment (threshold: 0.6)  
- **Agent365ResponseEvaluator**: Agent-specific evaluation criteria (threshold: 0.75, 1P only)