# Expert Evaluation Rubric (Human Evaluation of LLM-Generated Feedback)

Three independent evaluators with experience supervising or assessing oral
presentations (two university professors; one university lecturer in Korean
language education with thirty years of professional broadcasting experience;
none are authors) rated nine system-generated reports. Materials: one report
generated from a real 9.9-minute IR presentation and eight reports generated
from short (15–50 s) scripted voice-actor recordings (commercial/announcement
copy) from the scripted benchmark set, i.e., non-presentation control inputs.

Procedure: written instructions, a written rubric clarification, and a live
Q&A briefing on material provenance were provided; no scores were suggested;
scoring was independent. Raters could leave an item blank if they felt unable
to judge it (no rater used this option).

Each report was rated on six dimensions, each on a 5-point scale
(1 = poor, 5 = excellent):

1. **Evidence accuracy** — feedback statements are consistent with the
   measured quantities and transcript content presented in the report
   (including whether non-presentation input was correctly identified).
2. **Usefulness** — the feedback would actually help the speaker improve.
3. **Specificity / actionability** — recommendations are concrete enough to
   act on.
4. **Clarity** — the report is easy to read and understand.
5. **Appropriateness of anticipated questions** — the generated questions
   plausibly follow from the content and would help Q&A preparation.
6. **Overall quality** — overall impression relative to expert feedback.

Scores: see `expert_scores_anonymized.csv` (162 ratings: 3 raters x 9 reports
x 6 dimensions). Aggregation and Krippendorff's ordinal alpha as reported in
the paper (Section 6).
