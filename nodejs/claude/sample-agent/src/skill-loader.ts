// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as fs from 'fs';
import * as path from 'path';

/**
 * Load custom skills from the skills directory
 */
export interface SkillDefinition {
  name: string;
  description: string;
  content: string;
}

export class SkillLoader {
  private static skillsPath = path.join(__dirname, 'skills');

  /**
   * Load all custom skills from the skills directory
   */
  static loadCustomSkills(): SkillDefinition[] {
    const skills: SkillDefinition[] = [];
    
    try {
      if (!fs.existsSync(this.skillsPath)) {
        console.log('Skills directory not found:', this.skillsPath);
        return skills;
      }

      const skillDirs = fs.readdirSync(this.skillsPath, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

      for (const skillDir of skillDirs) {
        const skillPath = path.join(this.skillsPath, skillDir);
        const skillFile = path.join(skillPath, 'SKILL.md');
        
        if (fs.existsSync(skillFile)) {
          try {
            const content = fs.readFileSync(skillFile, 'utf-8');
            
            // Parse YAML front matter to get name and description
            const yamlMatch = content.match(/^---\n([\s\S]*?)\n---/);
            let name = skillDir;
            let description = `Custom skill: ${skillDir}`;
            
            if (yamlMatch) {
              const yamlContent = yamlMatch[1];
              const nameMatch = yamlContent.match(/name:\s*(.+)/);
              const descMatch = yamlContent.match(/description:\s*(.+)/);
              
              if (nameMatch) name = nameMatch[1].trim();
              if (descMatch) description = descMatch[1].trim();
            }
            
            skills.push({
              name,
              description,
              content
            });
            
            console.log(`✅ Loaded skill: ${name}`);
          } catch (error) {
            console.error(`❌ Error loading skill from ${skillFile}:`, error);
          }
        }
      }
    } catch (error) {
      console.error('Error reading skills directory:', error);
    }
    
    return skills;
  }

  /**
   * Get skill content for inclusion in system prompt
   */
  static getSkillsForSystemPrompt(): string {
    const skills = this.loadCustomSkills();
    
    if (skills.length === 0) {
      return '';
    }
    
    const skillSections = skills.map(skill => `
## ${skill.name}
${skill.content}
`).join('\n');
    
    return `
CLAUDE SKILLS - CUSTOM SKILLS LOADED:
The following custom skills are available for specialized functionality:

${skillSections}

Use these skills when handling related tasks by following the detailed instructions provided above.
`;
  }
}