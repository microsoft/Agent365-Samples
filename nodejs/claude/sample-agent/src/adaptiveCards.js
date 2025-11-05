/**
 * Adaptive Card utilities for Claude responses
 */

export function createClaudeResponseCard(response, userQuery) {
  // Clean and format the response text
  const formattedResponse = formatResponseText(response)
  
  return {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    type: "AdaptiveCard",
    body: [
      {
        type: "Container",
        style: "emphasis",
        items: [
          {
            type: "ColumnSet",
            columns: [
              {
                type: "Column",
                width: "auto",
                items: [
                  {
                    type: "Image",
                    url: "https://cdn.jsdelivr.net/gh/microsoft/fluentui-emoji/assets/Robot/3D/robot_3d.png",
                    size: "Small",
                    style: "Person"
                  }
                ]
              },
              {
                type: "Column",
                width: "stretch",
                items: [
                  {
                    type: "TextBlock",
                    text: "Claude Assistant",
                    weight: "Bolder",
                    size: "Medium"
                  },
                  {
                    type: "TextBlock",
                    text: `Responding to: "${truncateText(userQuery, 100)}"`,
                    isSubtle: true,
                    size: "Small",
                    wrap: true
                  }
                ]
              }
            ]
          }
        ]
      },
      {
        type: "Container",
        items: [
          {
            type: "TextBlock",
            text: formattedResponse,
            wrap: true,
            spacing: "Medium"
          }
        ]
      },
      {
        type: "Container",
        separator: true,
        items: [
          {
            type: "ColumnSet",
            columns: [
              {
                type: "Column",
                width: "stretch",
                items: [
                  {
                    type: "TextBlock",
                    text: `Generated at ${new Date().toLocaleTimeString()}`,
                    isSubtle: true,
                    size: "Small"
                  }
                ]
              },
              {
                type: "Column",
                width: "auto",
                items: [
                  {
                    type: "TextBlock",
                    text: "🤖 Powered by Claude Code SDK",
                    isSubtle: true,
                    size: "Small"
                  }
                ]
              }
            ]
          }
        ]
      }
    ],
    actions: [
      {
        type: "Action.Submit",
        title: "Ask Follow-up",
        data: {
          action: "followup",
          context: truncateText(response, 200)
        }
      }
    ]
  }
}

export function createErrorCard(error, userQuery) {
  return {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    type: "AdaptiveCard",
    body: [
      {
        type: "Container",
        style: "attention",
        items: [
          {
            type: "ColumnSet",
            columns: [
              {
                type: "Column",
                width: "auto",
                items: [
                  {
                    type: "TextBlock",
                    text: "⚠️",
                    size: "Large"
                  }
                ]
              },
              {
                type: "Column",
                width: "stretch",
                items: [
                  {
                    type: "TextBlock",
                    text: "Error Processing Request",
                    weight: "Bolder",
                    color: "Attention"
                  },
                  {
                    type: "TextBlock",
                    text: error.message || "An unexpected error occurred",
                    wrap: true,
                    isSubtle: true
                  }
                ]
              }
            ]
          }
        ]
      },
      {
        type: "Container",
        items: [
          {
            type: "TextBlock",
            text: "**Troubleshooting Steps:**",
            weight: "Bolder",
            spacing: "Medium"
          },
          {
            type: "TextBlock",
            text: "• Ensure ANTHROPIC_API_KEY is set in your environment",
            wrap: true
          },
          {
            type: "TextBlock",
            text: "• Get your API key from https://console.anthropic.com/",
            wrap: true,
            isSubtle: true
          },
          {
            type: "TextBlock",
            text: "• Check your network connection",
            wrap: true
          },
          {
            type: "TextBlock",
            text: "• Try rephrasing your question",
            wrap: true
          }
        ]
      }
    ],
    actions: [
      {
        type: "Action.Submit",
        title: "Try Again",
        data: {
          action: "retry",
          originalQuery: userQuery
        }
      }
    ]
  }
}

export function createThinkingCard(query) {
  return {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    type: "AdaptiveCard",
    body: [
      {
        type: "Container",
        style: "emphasis",
        items: [
          {
            type: "ColumnSet",
            columns: [
              {
                type: "Column",
                width: "auto",
                items: [
                  {
                    type: "TextBlock",
                    text: "🤔",
                    size: "Large"
                  }
                ]
              },
              {
                type: "Column",
                width: "stretch",
                items: [
                  {
                    type: "TextBlock",
                    text: "Claude is thinking...",
                    weight: "Bolder"
                  },
                  {
                    type: "TextBlock",
                    text: `Processing: "${truncateText(query, 80)}"`,
                    isSubtle: true,
                    wrap: true
                  }
                ]
              }
            ]
          }
        ]
      }
    ]
  }
}

function formatResponseText(text) {
  if (!text) return "No response received"
  
  // Basic markdown-like formatting for adaptive cards
  return text
    .replace(/\*\*(.*?)\*\*/g, '**$1**') // Keep bold
    .replace(/\*(.*?)\*/g, '*$1*') // Keep italic
    .replace(/`([^`]+)`/g, '`$1`') // Keep inline code
    .replace(/^### (.*$)/gm, '**$1**') // Convert h3 to bold
    .replace(/^## (.*$)/gm, '**$1**') // Convert h2 to bold
    .replace(/^# (.*$)/gm, '**$1**') // Convert h1 to bold
}

export function createCodeAnalysisCard(analysis, filePath, userQuery) {
  // Parse analysis if it's a string
  let analysisData
  try {
    analysisData = typeof analysis === 'string' ? JSON.parse(analysis) : analysis
  } catch {
    // If not JSON, treat as plain text analysis
    analysisData = { summary: analysis }
  }

  return {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    type: "AdaptiveCard",
    body: [
      {
        type: "Container",
        style: "emphasis",
        items: [
          {
            type: "ColumnSet",
            columns: [
              {
                type: "Column",
                width: "auto",
                items: [
                  {
                    type: "TextBlock",
                    text: "🔍",
                    size: "Large"
                  }
                ]
              },
              {
                type: "Column",
                width: "stretch",
                items: [
                  {
                    type: "TextBlock",
                    text: "Code Analysis Complete",
                    weight: "Bolder",
                    size: "Medium"
                  },
                  {
                    type: "TextBlock",
                    text: `File: ${filePath || 'Unknown'}`,
                    isSubtle: true,
                    size: "Small"
                  }
                ]
              }
            ]
          }
        ]
      },
      {
        type: "Container",
        items: [
          {
            type: "TextBlock",
            text: analysisData.summary || analysis,
            wrap: true,
            spacing: "Medium"
          }
        ]
      },
      ...(analysisData.issues ? [{
        type: "Container",
        separator: true,
        items: [
          {
            type: "TextBlock",
            text: "🚨 Issues Found",
            weight: "Bolder",
            color: "Attention"
          },
          ...analysisData.issues.slice(0, 5).map(issue => ({
            type: "TextBlock",
            text: `• **${issue.type || 'Issue'}**: ${issue.description || issue}`,
            wrap: true,
            spacing: "Small"
          }))
        ]
      }] : []),
      ...(analysisData.recommendations ? [{
        type: "Container",
        separator: true,
        items: [
          {
            type: "TextBlock",
            text: "💡 Recommendations",
            weight: "Bolder",
            color: "Good"
          },
          ...analysisData.recommendations.slice(0, 3).map(rec => ({
            type: "TextBlock",
            text: `• ${rec}`,
            wrap: true,
            spacing: "Small"
          }))
        ]
      }] : []),
      {
        type: "Container",
        separator: true,
        items: [
          {
            type: "ColumnSet",
            columns: [
              {
                type: "Column",
                width: "stretch",
                items: [
                  {
                    type: "TextBlock",
                    text: `Analyzed at ${new Date().toLocaleTimeString()}`,
                    isSubtle: true,
                    size: "Small"
                  }
                ]
              },
              {
                type: "Column",
                width: "auto",
                items: [
                  {
                    type: "TextBlock",
                    text: "🤖 Claude Code Analysis",
                    isSubtle: true,
                    size: "Small"
                  }
                ]
              }
            ]
          }
        ]
      }
    ],
    actions: [
      {
        type: "Action.Submit",
        title: "Analyze Another File",
        data: {
          action: "analyze_another",
          previousFile: filePath
        }
      },
      {
        type: "Action.Submit", 
        title: "Get Detailed Report",
        data: {
          action: "detailed_analysis",
          file: filePath
        }
      }
    ]
  }
}

function truncateText(text, maxLength) {
  if (!text) return ""
  if (text.length <= maxLength) return text
  return text.substring(0, maxLength - 3) + "..."
}