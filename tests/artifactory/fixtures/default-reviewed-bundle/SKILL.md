# Default Reviewed Bundle

Purpose: compile and execute the smallest reviewed bundle that exercises the package pipeline.

Quality bar:
- emit one `stub_artifact`
- keep runtime policy stub-only
- stay bounded to one source reference and one artifact

Invalid outputs:
- any extra capability
- any extra artifact beyond the reviewed cap
- any provider or credential request

Candidate shape:
- short-form artifact
- grounded in the packed source excerpt
- deterministic body text
