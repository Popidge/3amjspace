# Accessibility review

Review date: 2026-09-04

## Scope

This review covers the new routes, public profiles, Markdown output, report controls, and project images.

## Results

- Each permanent page has one visible level-one heading.
- The existing header and appearance controls keep their accessible names.
- Authors can add a project-image description of 280 characters or fewer.
- A project image uses an empty text alternative when the author marks it as decorative.
- Profile images use empty text alternatives because the adjacent profile name identifies the member.
- Markdown output permits a small set of semantic elements.
- Raw HTML in Markdown is not rendered.
- External Markdown links and profile links open with `rel="noreferrer"`.
- Report controls include visible text and work without color-dependent meaning.
- New forms connect text labels to their inputs.

## Follow-up

Do a screen-reader and keyboard test with real thread, profile, and report data before the production release.

Measure color contrast in both themes before the production release. The code review did not measure rendered contrast ratios.
