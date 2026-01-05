---
name: email-signature
description: Email enhancement that adds proper HTML formatting, agentic signature and enhancement notice
---

# Email Signature Skill

This skill enhances emails with proper HTML formatting, a simple signature from "Agentic User" and adds a notice that the email was enhanced with skills.

## Enhancement Rules

When working with any email-related tasks (composing, sending, replying, or drafting emails):

1. **Format Email as HTML**: Always format emails using HTML for proper display:
   - **Paragraphs**: Wrap in `<p>` tags with spacing
   - **Line breaks**: Use `<br>` tags where needed
   - **Bold text**: Use `<strong>` or `<b>` tags
   - **Lists**: Use `<ul>` and `<li>` tags for bullet points
   - **Sections**: Use proper HTML structure

2. **Add Signature**: Always end emails with:
   ```html
   <p>Best regards,<br>Agentic User</p>
   ```

3. **Add Enhancement Notice**: Include this line before the signature:
   ```html
   <p><em>This email was enhanced with skills.</em></p>
   ```

## HTML Email Formatting Standards

### Paragraph Structure
```html
<p>First paragraph content goes here.</p>
<p>Second paragraph content goes here.</p>
```

### List Formatting
```html
<p><strong>Samsung Refrigerators:</strong></p>
<ul>
<li>Known for innovative features and cutting-edge technology</li>
<li>Often include smart connectivity and touchscreen displays</li>
<li>Sleek, modern designs with premium finishes</li>
</ul>
```

### Section Headers
```html
<p><strong>Key Considerations:</strong></p>
<p><strong>Budget:</strong> Description of budget considerations.</p>
<p><strong>Features:</strong> Description of feature differences.</p>
```

## Complete Email HTML Structure

Every email should follow this HTML format:
```html
<p>[Greeting]</p>

<p>[Main content paragraph]</p>

<p><strong>[Section Header:]</strong></p>
<ul>
<li>[Bullet point 1]</li>
<li>[Bullet point 2]</li>
</ul>

<p>[Additional paragraphs]</p>

<p><em>This email was enhanced with skills.</em></p>

<p>Best regards,<br>Agentic User</p>
```

## When to Apply

Apply this enhancement automatically when:
- Creating new email drafts
- Composing email messages  
- Replying to emails
- Using any email-related MCP tools
- Content needs proper formatting for email display

## HTML Formatting Examples

**Proper HTML Email Format:**
```html
<p>Hello,</p>

<p>I wanted to share a comparison between Samsung and Whirlpool refrigerators to help with your decision.</p>

<p><strong>Samsung Refrigerators:</strong></p>
<ul>
<li>Known for innovative features and cutting-edge technology</li>
<li>Often include smart connectivity and touchscreen displays</li>
<li>Sleek, modern designs with premium finishes</li>
</ul>

<p><strong>Whirlpool Refrigerators:</strong></p>
<ul>
<li>Reputation for reliability and durability</li>
<li>More affordable pricing across their lineup</li>
<li>Practical features focused on everyday use</li>
</ul>

<p><strong>Key Considerations:</strong></p>
<p><strong>Budget:</strong> Whirlpool typically offers better value, while Samsung commands premium prices.</p>
<p><strong>Features:</strong> Samsung leads in smart technology and innovation.</p>

<p>I'd recommend Samsung if you want the latest technology. Choose Whirlpool for proven reliability and better value.</p>

<p><em>This email was enhanced with skills.</em></p>

<p>Best regards,<br>Agentic User</p>
```

Always use HTML formatting to ensure proper display in email clients.