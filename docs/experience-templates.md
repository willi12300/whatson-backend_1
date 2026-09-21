# Experience Templates

Templates are city-agnostic experience frameworks. They store roles and venue constraints, never venue IDs. SAPPO selects a template, finds live candidates in the requested city, validates the full timed route, then lets Gemini write only the explanation.

## Add a template

Use a CMS later to create one row in `experience_templates`, ordered role rows in `experience_template_stops`, and optional weighted rules in `experience_template_rules`. No backend code or fixed template ID is needed.

For the current seed, add a `T(...)` entry in `src/services/seedExperienceTemplates.js`. Each `S(...)` entry defines a role, allowed `category_slug` values, and optional rating, budget, ambience, walking distance, duration, required, and swappable flags. Restart/deploy once; the upsert seed is safe to rerun.

## Pipeline

`templateScoringService` ranks templates from time, weather, budget, audience, time available, energy and walking preference. `venueCandidateService` filters candidates by role, rating, location, opening hours and arrival time. `experienceAssembler` fills each role without duplicates. `experienceValidationService` checks every stop and route timing. If a build is invalid, the engine tries the next template. Gemini only receives the final stop names and is forbidden from changing them.
