# SehatMate API hackathon review update

## Included

- One structured instruction per medicine
- Duplicate medicine-duration merging
- Natural patient-facing ambiguity text rules
- Conservative RxNorm, DailyMed and openFDA name lookup
- Ingredient-label image transcription endpoint
- Ingredient-purpose consistency check with trusted-source citations
- No prescription field is changed by source or ingredient evidence

## New endpoint

`POST /api/instructions/:id/ingredient-evidence`

JSON body:

- `originalName`
- `mimeType` (`image/jpeg` or `image/png`)
- `contentBase64`

No new database table is required for this endpoint. Keep existing Hostinger environment variables and redeploy after pushing `server.js` and `ai_service.js`.

