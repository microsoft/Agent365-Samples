# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

# Agent365-Samples Gamification System 🎮🏆

## 🌟 View Your Stats

**The leaderboard displays directly in the main GitHub repository README!**

👉 **[View Live Leaderboard Here](https://github.com/microsoft/Agent365-Samples#-contributor-leaderboard)**

Just visit the repository homepage and scroll down to see:
- 🥇🥈🥉 Top contributors with medals
- ⭐ Your total points
- 🔥 Your contribution streak
- 📊 Your contribution count

**No setup required. Updated automatically every 6 hours by GitHub Actions.**

---

## 📊 How Points Are Earned

| Action | Base Points | Description |
|--------|-------------|-------------|
| Merge a Pull Request | 5 | Successfully merge a PR into the main branch |
| Create a Pull Request | 3 | Open a new PR for review |
| Close an Issue | 2 | Successfully close an issue |
| Fix a Bug (verified) | 10 | Fix a verified bug with proper testing |
| Add Unit Tests (>80% coverage) | 8 | Add comprehensive unit tests |
| Refactor for Performance | 6 | Improve code performance |
| Detailed Code Review | 10 | In-depth review with multiple comments |
| Basic Code Review | 5 | Review a PR with feedback |
| Performance Review Suggestion | 4 | Suggest optimizations during review |
| Approve PR after Changes | 3 | Approve PR after reviewing changes |
| Update README | 4 | Update or improve README documentation |
| Write Tutorial | 8 | Create comprehensive tutorial content |
| Answer Discussion/Issue | 2 | Help community members with questions |
| Create Video Demo | 10 | Create video demonstration or tutorial |
| Report Security Vulnerability | 15 | Responsibly report security issues |
| Fix Security Vulnerability | 20 | Fix verified security vulnerabilities |
| Pair Programming Session | 5 | Participate in pair programming |
| Mentor a New Contributor | 10 | Help onboard new contributors |

### 🎯 Multipliers & Bonuses

- **High Priority**: ×2 points (Issues/PRs labeled high priority)
- **Critical Priority**: ×3 points (Issues/PRs labeled critical)
- **Speed Bonus**: +20% (Complete within 24 hours)
- **Streak Bonus**: +10 points (5 consecutive days of contributions)
- **First-Time Contributor**: +5 points (Welcome bonus!)

---

## 🎖️ Badges

### Point-Based Badges

| Badge | Tier | Points Required |
|-------|------|-----------------|
| Rookie | Bronze | 10 |
| Contributor | Bronze | 50 |
| Regular | Silver | 100 |
| Expert | Silver | 250 |
| Master | Gold | 500 |
| Legend | Gold | 1000 |
| Champion | Platinum | 2500 |

### Achievement Badges

| Badge | Tier | Criteria |
|-------|------|----------|
| Code Warrior | Silver | Merge 10+ Pull Requests |
| Review Master | Silver | Complete 20+ detailed code reviews |
| Bug Squasher | Gold | Fix 5+ verified bugs |
| Documentation Hero | Silver | Earn 50+ points from documentation |
| Security Guardian | Platinum | Report or fix security vulnerability |
| Mentor | Gold | Mentor 3+ new contributors |
| Speed Demon | Gold | Complete 10+ tasks within 24 hours |
| Streak Master | Gold | Maintain 30-day contribution streak |
| First Timer | Special | Make your first contribution |
| All Rounder | Platinum | Contribute across all 5 categories |

---

## 🛠️ For Maintainers: How to Award Points

### Option 1: Interactive CLI (Recommended)

```bash
cd gamification/python
python manage_points.py
```

This launches an interactive menu where you can:
- Award points for PRs, issues, reviews, documentation
- View contributor profiles
- Check leaderboard
- Award custom points

### Option 2: GitHub Actions (Automatic)

Points are awarded automatically when:
- PRs are merged
- Issues are closed

The workflow runs automatically in the repository. See `.github/workflows/auto-award-points.yml`

---

## 🔄 How the Leaderboard Updates

1. **GitHub Actions runs every 6 hours** (`.github/workflows/update-leaderboard.yml`)
2. Queries the database for latest contributor stats
3. Generates HTML table with rankings, medals, and stats
4. Updates main README.md between special markers
5. Commits changes automatically

**Manual update:**
```bash
cd gamification/python
python update_readme.py
```

---

## 📁 Essential Files

```
gamification/
├── README.md                    # This file
├── database/
│   └── schema.sql              # Database schema
├── python/
│   ├── manage_points.py        # 👈 Interactive CLI to award points
│   ├── database.py             # Database operations
│   ├── points_service.py       # Points calculation engine
│   ├── update_readme.py        # 👈 Updates GitHub README (used by Actions)
│   ├── generate_leaderboard_md.py  # Generates detailed leaderboard
│   └── gamification.db         # SQLite database (auto-created)
└── .github/workflows/
    ├── auto-award-points.yml   # Automatic point awarding
    └── update-leaderboard.yml  # 👈 Updates README every 6 hours
```

**Key Scripts:**
- **`manage_points.py`** - Award points manually (maintainers)
- **`update_readme.py`** - Update the main README leaderboard (GitHub Actions uses this)

---

## 🚀 Quick Start

### For Contributors (View Stats)

Visit: **[github.com/microsoft/Agent365-Samples](https://github.com/microsoft/Agent365-Samples)**

Scroll down to see the 🏆 **Contributor Leaderboard** section. That's it!

### For Maintainers (Award Points)

```bash
cd gamification/python
python manage_points.py
```

---

## 💡 Key Features

✅ **Zero Setup for Viewing** - Leaderboard embedded directly in GitHub README  
✅ **Automatic Updates** - GitHub Actions updates every 6 hours  
✅ **Simple Point Awarding** - Interactive CLI for maintainers  
✅ **Automatic Tracking** - GitHub Actions awards points on PR merge/issue close  
✅ **Comprehensive Scoring** - Points, multipliers, bonuses, streaks  
✅ **Badge System** - 17 badges from Bronze to Platinum  
✅ **No External Tools** - Everything stays in GitHub  

---

## 📝 License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the MIT License.
