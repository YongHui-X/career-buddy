# Career Ops

Career Ops is Yong Hui's career management system.

## Purpose

Maintain a structured record of:
- job opportunities
- companies
- applications
- interviews
- follow ups
- research
- generated application documents

## Source of truth

career_ops.db is the canonical source of truth for dynamic career data.

config/job_preferences.yaml is the canonical source of truth for
job matching and scoring preferences.

Do not rely on conversational memory for exact application status
or scoring criteria.

## Job discovery

When evaluating jobs:

1. Read config/job_preferences.yaml.
2. Check Career Ops for duplicates.
3. Score the role.
4. Explain the score.
5. Store relevant results in Career Ops.
6. Never submit an application without explicit user approval.

## Existing data

Never overwrite existing application history unless explicitly instructed.

## User interaction

Present the strongest matches first.
Explain major strengths and concerns concisely.
Flag evidence of LeetCode or lengthy assessments.