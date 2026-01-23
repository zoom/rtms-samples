# Contributing to RTMS Samples

Thank you for your interest in contributing! This document provides guidelines for contributing to the RTMS Samples repository.

## Getting Started

1. Fork the repository
2. Clone your fork locally
3. Create a new branch for your feature/fix

## Code Style

### Naming Conventions

- **Folders**: Use `snake_case` with language suffix
  - `send_audio_to_deepgram_transcribe_service_js`
  - `save_transcript_sdk`
- **Files**: Use `camelCase` for JavaScript, `snake_case` for Python
- **Language suffixes**: `_js`, `_sdk`, `_python`, `_go`, `_java`

### README Format

Each sample should include a `README.md` with:
1. Title and description
2. Prerequisites (environment variables)
3. Implementation details / flow
4. Running instructions
5. Project-specific features
6. Troubleshooting section

### Environment Variables

- Use `.env.example` to document required variables
- Never commit actual `.env` files
- Use `ZOOM_` prefix for Zoom credentials

## Submitting Changes

### Pull Request Process

1. Ensure your code follows the naming conventions
2. Update the sample's README if needed
3. Test your changes locally
4. Create a PR with a clear description

### PR Title Format

```
[category] Brief description
```

Examples:
- `[audio] Add Google Speech-to-Text sample`
- `[boilerplate] Fix Python WebSocket reconnection`
- `[docs] Update ARCHITECTURE.md diagram`

### Commit Messages

- Use present tense ("Add feature" not "Added feature")
- Keep first line under 72 characters
- Reference issues when applicable

## Adding a New Sample

1. Create folder in appropriate category with correct naming
2. Include `README.md` following the standard format
3. Include `.env.example` with required variables
4. Add `package.json` (JS) or `requirements.txt` (Python)
5. Update the main `README.md` if adding a new category

## Questions?

Open an issue for questions or discussions about potential contributions.
