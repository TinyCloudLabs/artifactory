# Exception Alert

Surface only meaningful deviations from an expected baseline. This workflow is
quiet by design: when no supported exception exists it emits no artifact and no
Feed post.

Quality bar:
- identify both the expected baseline and observed deviation in the selected
  authorized source window; configured baseline text is a filter, not evidence
- explain impact, urgency, and confidence
- cite authorized evidence for the deviation
- publish nothing when the source window contains no exception

Invalid outputs:
- routine status reported as an alert
- a deviation without a named baseline
- a quiet run represented by an empty artifact
