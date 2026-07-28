# PDF generation failure handoff

## What is failing

The Python runtime can generate PDFs. The captured transcript proves this with a
successful ReportLab write to `/tmp/story.pdf` (`PDF size: 1354 bytes`). The
same kind of write appears to fail when the PDF is placed in the conversation
workspace.

The failure happens after Python execution:

1. `ModalPythonExecutor.run()` snapshots `/workspace`, runs Python, and
   auto-discovers new or changed files.
2. `executePythonTool()` treats every discovered PDF/DOCX as an editable
   document and calls `registerGeneratedDocumentProvenance()`.
3. Provenance registration creates a document project/revision and depends on
   the document-project Supabase schema and storage flow.
4. Any error in that secondary registration used to escape the artifact loop.
   The outer catch then returned a failed `run_python` result, discarding the
   successful process output and downloadable PDF.
5. `/tmp` seemed to “fix” generation only because it is outside `/workspace`
   and therefore bypasses artifact discovery and provenance registration. It
   cannot be requested as an artifact because artifact paths must be safe,
   workspace-relative paths.

This explains why text writes worked, why a minimal `/tmp` PDF worked, and why
workspace PDF attempts produced a generic Python failure despite ReportLab
being installed.

## Generation-path fix in this change

PDF/DOCX provenance enrichment is now best-effort. When registration succeeds,
the artifact remains editable and source-backed. When it fails, the original
workspace file is returned as a signed, owner-scoped, non-editable downloadable
artifact. The Python exit code, stdout, and stderr remain authoritative.

The server emits a bounded `generated-document-provenance-fallback` warning
containing identifiers, artifact MIME type, and error class only. It does not
log exception messages, storage paths, credentials, or generated content.

The model guidance now explicitly says to write downloadable outputs to a
relative workspace path and include that exact path in `artifacts`.

## Work intentionally left for the edit-path agent

This change does not modify PDF inspection, source rerendering, object editing,
overlay/raster editing, revision comparison, or edit-route behavior. The edit
agent can independently repair or extend those paths.

The fallback artifact deliberately has `editable: false` and no project or
revision IDs. It should remain downloadable through the existing authenticated
artifact route, but edit tools should not treat it as source-backed.

## Infrastructure follow-up

Deploy and verify the document-project migrations (especially
`supabase/migrations/20260727190000_document_projects.sql` and
`supabase/migrations/20260727220000_pdf_edit_revisions.sql`) plus the required
Supabase storage configuration. Healthy infrastructure will continue producing
editable generated PDFs; the fallback prevents infrastructure drift from
blocking basic file creation.
