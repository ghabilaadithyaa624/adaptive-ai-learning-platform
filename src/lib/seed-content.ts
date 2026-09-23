export type SeedQuestion = [string, string[], number, "easy" | "medium" | "hard" | "expert", string, string];

export const SEED_SUBJECTS = [
  { name: "Mathematics", code: "MATH", color: "#6366f1" },
  { name: "Programming", code: "CODE", color: "#10b981" },
  { name: "Data Science", code: "DATA", color: "#0ea5e9" },
  { name: "Physics", code: "PHYS", color: "#f59e0b" },
  { name: "Communication", code: "COMM", color: "#ec4899" },
];

export type SeedSkill = {
  code: string;
  name: string;
  subjectCode: string;
  description: string;
  difficultyBase: number;
  gradeBand: string;
  prereqs: string[];
};

export const SEED_SKILLS: SeedSkill[] = [
  { code: "MATH.01", name: "Fractions, Ratios & Proportion", subjectCode: "MATH", description: "Reasoning with rational quantities and proportional relationships.", difficultyBase: 0.3, gradeBand: "Foundational", prereqs: [] },
  { code: "MATH.02", name: "Linear Equations & Inequalities", subjectCode: "MATH", description: "Solving and modelling linear relationships.", difficultyBase: 0.42, gradeBand: "Foundational", prereqs: ["MATH.01"] },
  { code: "MATH.03", name: "Quadratic Functions", subjectCode: "MATH", description: "Factoring, roots, vertex form and applied optimisation.", difficultyBase: 0.62, gradeBand: "Core", prereqs: ["MATH.02"] },
  { code: "MATH.04", name: "Probability Foundations", subjectCode: "MATH", description: "Sample spaces, conditional probability, Bayes' rule.", difficultyBase: 0.58, gradeBand: "Core", prereqs: ["MATH.01"] },
  { code: "MATH.05", name: "Inferential Statistics", subjectCode: "MATH", description: "Confidence intervals, hypothesis testing, power.", difficultyBase: 0.72, gradeBand: "Advanced", prereqs: ["MATH.04"] },
  { code: "MATH.06", name: "Functions & Graphical Reasoning", subjectCode: "MATH", description: "Interpreting families of functions and their transformations.", difficultyBase: 0.5, gradeBand: "Core", prereqs: ["MATH.02"] },
  { code: "MATH.07", name: "Geometry & Measurement", subjectCode: "MATH", description: "Area, volume, similarity and coordinate geometry.", difficultyBase: 0.45, gradeBand: "Foundational", prereqs: ["MATH.01"] },
  { code: "MATH.08", name: "Trigonometry", subjectCode: "MATH", description: "Unit circle, identities and periodic modelling.", difficultyBase: 0.75, gradeBand: "Advanced", prereqs: ["MATH.06"] },
  { code: "CODE.01", name: "Syntax & Control Flow", subjectCode: "CODE", description: "Variables, conditionals, loops and functions in a typed language.", difficultyBase: 0.28, gradeBand: "Foundational", prereqs: [] },
  { code: "CODE.02", name: "Data Structures", subjectCode: "CODE", description: "Arrays, maps, stacks, queues and complexity trade-offs.", difficultyBase: 0.5, gradeBand: "Core", prereqs: ["CODE.01"] },
  { code: "CODE.03", name: "Algorithms & Complexity", subjectCode: "CODE", description: "Search, sort, greedy and Big-O analysis.", difficultyBase: 0.66, gradeBand: "Core", prereqs: ["CODE.02"] },
  { code: "CODE.04", name: "Recursion & Dynamic Programming", subjectCode: "CODE", description: "Divide and conquer, memoisation, tabulation.", difficultyBase: 0.8, gradeBand: "Advanced", prereqs: ["CODE.03"] },
  { code: "CODE.05", name: "Object-Oriented Design", subjectCode: "CODE", description: "Encapsulation, interfaces and design patterns.", difficultyBase: 0.6, gradeBand: "Core", prereqs: ["CODE.02"] },
  { code: "CODE.06", name: "Testing & Debugging", subjectCode: "CODE", description: "Unit tests, test doubles and systematic fault isolation.", difficultyBase: 0.46, gradeBand: "Core", prereqs: ["CODE.01"] },
  { code: "DATA.01", name: "Data Literacy & Wrangling", subjectCode: "DATA", description: "Tidy data, joins, missing values and types.", difficultyBase: 0.32, gradeBand: "Foundational", prereqs: [] },
  { code: "DATA.02", name: "Descriptive Statistics & EDA", subjectCode: "DATA", description: "Distributions, correlation and visual diagnostics.", difficultyBase: 0.48, gradeBand: "Core", prereqs: ["DATA.01"] },
  { code: "DATA.03", name: "Regression Modelling", subjectCode: "DATA", description: "OLS, regularisation and residual analysis.", difficultyBase: 0.66, gradeBand: "Advanced", prereqs: ["DATA.02", "MATH.05"] },
  { code: "DATA.04", name: "Classification Models", subjectCode: "DATA", description: "Logistic regression, trees, ensembles and calibration.", difficultyBase: 0.74, gradeBand: "Advanced", prereqs: ["DATA.03"] },
  { code: "DATA.05", name: "Model Evaluation & Validation", subjectCode: "DATA", description: "Cross-validation, AUC, confusion analysis, leakage.", difficultyBase: 0.7, gradeBand: "Advanced", prereqs: ["DATA.04"] },
  { code: "DATA.06", name: "Feature Engineering", subjectCode: "DATA", description: "Encoding, scaling, interactions and temporal features.", difficultyBase: 0.58, gradeBand: "Core", prereqs: ["DATA.02"] },
  { code: "PHYS.01", name: "Kinematics", subjectCode: "PHYS", description: "Motion graphs, velocity and acceleration.", difficultyBase: 0.38, gradeBand: "Foundational", prereqs: [] },
  { code: "PHYS.02", name: "Forces & Newton's Laws", subjectCode: "PHYS", description: "Free-body diagrams and dynamics.", difficultyBase: 0.55, gradeBand: "Core", prereqs: ["PHYS.01"] },
  { code: "PHYS.03", name: "Energy, Work & Momentum", subjectCode: "PHYS", description: "Conservation laws applied to systems.", difficultyBase: 0.68, gradeBand: "Advanced", prereqs: ["PHYS.02"] },
  { code: "PHYS.04", name: "Electric Circuits", subjectCode: "PHYS", description: "Ohm's law, series/parallel networks, power.", difficultyBase: 0.6, gradeBand: "Core", prereqs: ["PHYS.02"] },
  { code: "COMM.01", name: "Reading Comprehension", subjectCode: "COMM", description: "Inference, evidence and author intent.", difficultyBase: 0.34, gradeBand: "Foundational", prereqs: [] },
  { code: "COMM.02", name: "Argumentative Writing", subjectCode: "COMM", description: "Claim, evidence, warrant structuring.", difficultyBase: 0.52, gradeBand: "Core", prereqs: ["COMM.01"] },
  { code: "COMM.03", name: "Academic Vocabulary", subjectCode: "COMM", description: "Domain register, morphology and precision.", difficultyBase: 0.4, gradeBand: "Core", prereqs: ["COMM.01"] },
  { code: "COMM.04", name: "Presentation & Rhetoric", subjectCode: "COMM", description: "Audience analysis, structure and delivery.", difficultyBase: 0.6, gradeBand: "Advanced", prereqs: ["COMM.03"] },
];

export const QUESTION_BANK: Record<string, SeedQuestion[]> = {
  "MATH.01": [
    ["A recipe uses flour and sugar in a 5:2 ratio. With 750 g of flour, how much sugar is needed?", ["300 g", "250 g", "375 g", "420 g"], 0, "easy", "remember", "750 ÷ 5 = 150 per part, then 2 × 150 = 300 g."],
    ["If 3/8 of a class of 64 students walk to school, how many walk?", ["16", "24", "20", "28"], 1, "easy", "apply", "64 × 3/8 = 24."],
    ["A map scale is 1:25,000. Two towns are 7.5 cm apart on the map. Real distance?", ["1.875 km", "18.75 km", "0.75 km", "7.5 km"], 0, "medium", "apply", "7.5 × 25,000 = 187,500 cm = 1.875 km."],
  ],
  "MATH.02": [
    ["Solve 4x + 7 = 31.", ["x = 5", "x = 6", "x = 7", "x = 8"], 1, "easy", "apply", "4x = 24 so x = 6."],
    ["Which inequality describes 'at most 12 items' for item count n?", ["n ≥ 12", "n ≤ 12", "n > 12", "n ≠ 12"], 1, "easy", "understand", "'At most' means less than or equal to."],
    ["A taxi charges $3 plus $1.80 per km. For a $21 fare, distance travelled is:", ["8 km", "9 km", "10 km", "11 km"], 2, "medium", "apply", "(21 − 3) ÷ 1.8 = 10 km."],
  ],
  "MATH.03": [
    ["What are the roots of x² − 5x + 6 = 0?", ["x = 2 and 3", "x = −2 and −3", "x = 1 and 6", "x = −1 and 6"], 0, "easy", "apply", "Factor to (x−2)(x−3)."],
    ["The vertex of y = 2(x − 3)² + 5 is:", ["(3, 5)", "(−3, 5)", "(5, 3)", "(3, −5)"], 0, "medium", "understand", "Vertex form y = a(x−h)² + k gives (h, k)."],
    ["A projectile height is h = −5t² + 20t. Maximum height reached is:", ["10 m", "15 m", "20 m", "25 m"], 2, "hard", "apply", "Vertex at t = 2 s, h = −20 + 40 = 20 m."],
  ],
  "MATH.04": [
    ["Two fair dice are rolled. P(sum = 7)?", ["1/6", "1/9", "1/12", "5/36"], 0, "easy", "remember", "6 favourable outcomes out of 36."],
    ["P(A) = 0.4, P(B|A) = 0.5. What is P(A ∩ B)?", ["0.2", "0.45", "0.9", "0.1"], 0, "medium", "apply", "Multiply: 0.4 × 0.5 = 0.2."],
    ["A test is 95% sensitive and 2% false-positive; prevalence is 1%. P(disease | positive) is closest to:", ["32%", "5%", "50%", "1%"], 0, "hard", "analyze", "Bayes: 0.0095 / (0.0095 + 0.0198) ≈ 0.324."],
  ],
  "MATH.05": [
    ["A 95% confidence interval most directly expresses:", ["Range containing the true parameter in 95% of repeated samples", "Probability the parameter is in the interval", "Spread of the raw data", "Chance the study replicates"], 0, "medium", "understand", "Frequentist coverage interpretation."],
    ["Sample mean 42, sd 8, n = 64. Standard error is:", ["0.5", "1", "2", "8"], 1, "medium", "apply", "SE = s / √n = 8 / 8 = 1."],
    ["Reducing a study's alpha from 0.05 to 0.01 while holding n fixed will:", ["Lower power and lower type-I error", "Raise power", "Not affect power", "Only lower power"], 0, "hard", "analyze", "Stricter alpha cuts false positives but increases type-II risk."],
  ],
  "MATH.06": [
    ["If f(x) = x³, what does f(x − 2) do to the graph?", ["Shifts right 2", "Shifts left 2", "Shifts up 2", "Shrinks vertically"], 0, "medium", "understand", "Inside-function subtraction shifts right."],
    ["Which function grows fastest as x → ∞?", ["log x", "√x", "x²", "2^x"], 3, "medium", "analyze", "Exponential dominates polynomial growth."],
    ["The inverse of f(x) = 2x + 6 is:", ["f⁻¹(x) = (x − 6)/2", "f⁻¹(x) = 6 − 2x", "f⁻¹(x) = x/2 + 6", "f⁻¹(x) = 2x − 6"], 0, "medium", "apply", "Swap x and y then solve for y."],
  ],
  "MATH.07": [
    ["A circle has radius 7. Its area is closest to:", ["154", "44", "49", "22"], 0, "easy", "remember", "A = πr² ≈ 3.14 × 49 = 153.9."],
    ["Two similar triangles have perimeters in ratio 3:5. Area ratio?", ["3:5", "9:25", "6:10", "√3:√5"], 1, "medium", "apply", "Areas scale with the square of the linear ratio."],
    ["A cone and cylinder share radius and height. Volume of the cone is:", ["Equal", "1/2", "1/3", "3×"], 2, "medium", "remember", "Cone volume is one third of the matching cylinder."],
  ],
  "MATH.08": [
    ["sin(30°) equals:", ["1/2", "√3/2", "1", "√2/2"], 0, "easy", "remember", "Standard unit-circle value."],
    ["Which identity is correct?", ["sin²θ + cos²θ = 1", "sin θ = cos θ", "tan θ = cos θ / sin θ", "1 + tan²θ = sin²θ"], 0, "easy", "remember", "Pythagorean identity."],
    ["A 12 m ladder leans at 65° to the ground. Height reached?", ["≈10.9 m", "≈5.1 m", "≈12.1 m", "≈8.4 m"], 0, "hard", "apply", "12 × sin 65° ≈ 10.88 m."],
  ],
  "CODE.01": [
    ["In most typed languages, which construct repeats the body while a condition holds?", ["while loop", "if statement", "function", "return"], 0, "easy", "remember", "Loops repeat, conditionals branch."],
    ["What does `for (let i = 0; i < 3; i++) log(i)` print?", ["0 1 2", "1 2 3", "0 1 2 3", "1 1 1"], 0, "easy", "apply", "Zero-indexed, stops before 3."],
    ["Given `const xs = [1,2,3]; xs.map(x => x * 2)`, the result is:", ["[2,4,6]", "[1,2,3]", "6", "[1,4,9]"], 0, "medium", "apply", "map transforms each element."],
  ],
  "CODE.02": [
    ["Which structure gives O(1) average lookup by key?", ["Hash map", "Linked list", "Sorted array", "Stack"], 0, "easy", "remember", "Hashing gives constant average access."],
    ["A queue processes items in order:", ["LIFO", "FIFO", "Random", "Priority by insertion time"], 1, "easy", "understand", "Queue = first in, first out."],
    ["Appending to a dynamic array that must grow is:", ["Always O(1)", "Amortised O(1)", "O(log n)", "O(n²)"], 1, "hard", "analyze", "Occasional doubling gives amortised constant time."],
  ],
  "CODE.03": [
    ["Binary search requires the input to be:", ["Sorted", "Unique", "Numeric", "Small"], 0, "easy", "remember", "Ordering enables halving the search space."],
    ["Time complexity of merge sort:", ["O(n²)", "O(n log n)", "O(log n)", "O(n)"], 1, "easy", "remember", "Divide and merge gives n log n."],
    ["A greedy algorithm is guaranteed optimal for:", ["Fractional knapsack", "0/1 knapsack", "Travelling salesman", "Longest path"], 0, "hard", "evaluate", "Fractional knapsack has the greedy-choice property."],
  ],
  "CODE.04": [
    ["A recursive function must always have:", ["A base case", "A global variable", "Two parameters", "A loop"], 0, "easy", "remember", "Without a base case you recurse forever."],
    ["Naive Fibonacci recursion without memoisation runs in:", ["O(2ⁿ)", "O(n)", "O(n log n)", "O(log n)"], 0, "medium", "analyze", "Each call branches twice: exponential."],
    ["Memoisation improves DP by:", ["Reusing overlapping subproblem results", "Sorting inputs", "Reducing memory", "Parallelising"], 0, "medium", "understand", "Caching removes recomputation."],
  ],
  "CODE.05": [
    ["Encapsulation primarily means:", ["Hiding internal state behind a public interface", "Inheriting behaviour", "Overloading operators", "Compiling faster"], 0, "easy", "understand", "Protect invariants behind methods."],
    ["Which principle says classes should be open for extension, closed for modification?", ["Open/Closed", "Liskov", "Demeter", "KISS"], 0, "medium", "remember", "Extend via new code rather than edits."],
    ["Program to an interface rather than a concrete class mainly improves:", ["Substitutability and testability", "Raw speed", "Memory use", "Compile time"], 0, "hard", "evaluate", "Decoupling enables swapping implementations and doubles."],
  ],
  "CODE.06": [
    ["A unit test should ideally:", ["Cover one behaviour and be deterministic", "Touch the network", "Depend on test order", "Assert many outcomes at once"], 0, "easy", "understand", "Deterministic, isolated, focused."],
    ["A common cause of flaky tests is:", ["Shared mutable state between tests", "Using assertions", "Fixtures", "Type checking"], 0, "medium", "analyze", "Leaked state makes order matter."],
    ["Given a failing test, the fastest first step is to:", ["Reproduce the failure in isolation", "Rewrite the module", "Add more tests", "Disable logging"], 0, "medium", "apply", "Shrink the failure surface before changing code."],
  ],
  "DATA.01": [
    ["What does 'tidy data' mean?", ["One row per observation, one column per variable", "Data sorted alphabetically", "Data with no nulls", "Compressed data"], 0, "easy", "remember", "Tidy structure enables consistent tooling."],
    ["A LEFT JOIN between orders and returns keeps:", ["All orders", "Only matched rows", "All returns", "The cartesian product"], 0, "medium", "apply", "Left join preserves the left table's rows."],
    ["Mean-imputing a numeric column with 40% missingness risks:", ["Attenuated variance and biased inference", "Type errors", "Faster queries", "Nothing"], 0, "hard", "evaluate", "Imputation distorts distribution and uncertainty."],
  ],
  "DATA.02": [
    ["The measure least sensitive to outliers is the:", ["Median", "Mean", "Range", "Standard deviation"], 0, "easy", "understand", "Median depends on rank, not magnitude."],
    ["A right-skewed distribution has:", ["Mean > median", "Mean < median", "Mean = median", "No mode"], 0, "medium", "analyze", "The tail pulls the mean upward."],
    ["Pearson r = 0.85 between two variables implies:", ["Strong linear association", "Causation", "No relationship", "Perfect prediction"], 0, "medium", "evaluate", "Correlation is not causation."],
  ],
  "DATA.03": [
    ["Adding an irrelevant predictor to OLS will generally:", ["Raise R² but not improve generalisation", "Lower R²", "Improve test AUC", "Remove bias"], 0, "medium", "analyze", "Adjusted R² and CV expose the illusion."],
    ["Ridge regression differs from OLS by:", ["Adding an L2 penalty on coefficients", "Dropping outliers", "Scaling targets", "Bootstrapping"], 0, "medium", "remember", "Shrinking coefficients controls variance."],
    ["Heteroscedastic residuals most directly threaten:", ["Standard-error validity", "Point predictions", "Feature scaling", "Sample size"], 0, "hard", "evaluate", "Non-constant variance breaks inference assumptions."],
  ],
  "DATA.04": [
    ["Logistic regression outputs probabilities via:", ["The sigmoid of a linear combination", "A decision boundary only", "Euclidean distance", "A kernel trick"], 0, "medium", "remember", "σ(z) maps real values to (0,1)."],
    ["A random forest reduces variance primarily by:", ["Averaging decorrelated trees", "Deep single trees", "Feature scaling", "Pruning leaves"], 0, "medium", "analyze", "Bagging plus feature subsampling decorrelates trees."],
    ["If predicted probabilities are clustered at 0.5 on a binary task, the model is likely:", ["Under-confident and under-fit", "Over-confident", "Perfectly calibrated", "Over-fit"], 0, "expert", "evaluate", "Weak gradients suggest insufficient capacity or features."],
  ],
  "DATA.05": [
    ["k-fold cross-validation is used to:", ["Estimate out-of-sample performance", "Increase training size", "Tune hyperparameters only", "Shuffle classes"], 0, "medium", "apply", "Rotation gives a robust generalisation estimate."],
    ["AUC of 0.5 means the classifier is:", ["Equivalent to random ranking", "Perfect", "Inverted", "Overfit"], 0, "easy", "remember", "0.5 = no discrimination."],
    ["Fitting a scaler on the full dataset before splitting causes:", ["Data leakage", "Underfitting", "Class imbalance", "Nothing problematic"], 0, "hard", "evaluate", "Test statistics leak into training preprocessing."],
  ],
  "DATA.06": [
    ["One-hot encoding is inappropriate when:", ["A categorical column has very high cardinality", "There are two levels", "Data are numeric", "Data are normalised"], 0, "medium", "analyze", "Sparse explosion; prefer target or hashing encodings."],
    ["Standardising features mainly helps:", ["Distance and gradient-based models", "Tree-based models", "Text tokenisation", "Joins"], 0, "medium", "understand", "Scale-sensitive optimisers converge better."],
    ["A temporal feature like 'days since last purchase' is valuable because it:", ["Encodes recency signal", "Adds noise", "Removes seasonality", "Prevents leakage"], 0, "hard", "evaluate", "Recency often dominates churn/retention signals."],
  ],
  "PHYS.01": [
    ["Velocity is the slope of a:", ["Position–time graph", "Acceleration–time graph", "Force–time graph", "Momentum–time graph"], 0, "easy", "remember", "v = ds/dt."],
    ["A car accelerates from rest at 3 m/s² for 4 s. Distance travelled?", ["12 m", "24 m", "36 m", "48 m"], 1, "medium", "apply", "s = ½at² = ½ × 3 × 16 = 24 m."],
    ["Uniform circular motion at constant speed has:", ["Non-zero acceleration", "Zero acceleration", "Zero velocity", "Constant velocity vector"], 0, "hard", "analyze", "Direction changes so velocity changes."],
  ],
  "PHYS.02": [
    ["Newton's second law states:", ["F = ma", "F = mv", "F = m/a", "F = ma²"], 0, "easy", "remember", "Net force equals mass × acceleration."],
    ["A 5 kg block on a frictionless surface pushed with 20 N accelerates at:", ["2 m/s²", "4 m/s²", "10 m/s²", "100 m/s²"], 1, "easy", "apply", "a = F/m = 4 m/s²."],
    ["For a block at rest on an incline with friction, the friction force is:", ["Static and bounded by μsN", "Always μkN", "Zero", "Equal to weight"], 0, "hard", "analyze", "Static friction self-adjusts up to its limit."],
  ],
  "PHYS.03": [
    ["Work done by a force perpendicular to displacement is:", ["Zero", "Maximum", "Negative", "Equal to force"], 0, "easy", "understand", "W = Fd cos θ with θ = 90°."],
    ["A 2 kg ball at 5 m/s has kinetic energy of:", ["25 J", "10 J", "50 J", "5 J"], 0, "medium", "apply", "½mv² = ½ × 2 × 25 = 25 J."],
    ["In a perfectly elastic collision, which quantity is conserved for the system?", ["Both momentum and kinetic energy", "Only momentum", "Only energy in heat", "Neither"], 0, "hard", "evaluate", "Elastic implies kinetic energy conservation."],
  ],
  "PHYS.04": [
    ["Resistors of 4 Ω and 12 Ω in parallel give:", ["3 Ω", "16 Ω", "8 Ω", "48 Ω"], 0, "medium", "apply", "1/R = 1/4 + 1/12 → R = 3 Ω."],
    ["A 12 V source drives 0.5 A. Circuit resistance?", ["24 Ω", "6 Ω", "12 Ω", "0.04 Ω"], 0, "easy", "apply", "R = V/I = 24 Ω."],
    ["Adding a resistor in parallel to an existing branch will:", ["Decrease total resistance and increase total current", "Increase total resistance", "Not change current", "Decrease current"], 0, "hard", "analyze", "More parallel paths lower equivalent resistance."],
  ],
  "COMM.01": [
    ["An inference is a conclusion that:", ["Goes beyond the literal text using evidence", "Repeats the text", "Quotes the author", "Summarises a title"], 0, "easy", "understand", "Inference = evidence + reasoning."],
    ["The strongest distractor in an evidence question is usually one that is:", ["True but unrelated to the claim", "Obviously false", "Too short", "Copied verbatim"], 0, "medium", "analyze", "Plausible-but-irrelevant answers lure readers."],
    ["An author who presents one-sided evidence but concedes a counterpoint is:", ["Partially balanced", "Fully objective", "Biased without nuance", "Incoherent"], 0, "hard", "evaluate", "A concession signals some balance."],
  ],
  "COMM.02": [
    ["A thesis statement should be:", ["Specific, arguable and concise", "A question", "A list of sources", "A definition"], 0, "easy", "remember", "It must be claimable and defensible."],
    ["The 'warrant' in an argument links:", ["Evidence to the claim", "Title to body", "Source to citation", "Conclusion to intro"], 0, "medium", "understand", "Warrants explain why the evidence matters."],
    ["The strongest rebuttal paragraph will:", ["Steelman the opposing view before answering it", "Ignore the counterargument", "Use insults", "Restate the thesis"], 0, "hard", "evaluate", "Engaging the best version of the opposition is most persuasive."],
  ],
  "COMM.03": [
    ["The word 'ubiquitous' means:", ["Present everywhere", "Rare", "Ambiguous", "Ancient"], 0, "easy", "remember", "Ubiquity = being widespread."],
    ["Which transition signals contrast?", ["However", "Moreover", "Therefore", "Similarly"], 0, "easy", "apply", "'However' pivots direction."],
    ["'Mitigate' differs from 'militate' in that 'mitigate' means to:", ["Make less severe", "Argue against", "Fight in a war", "Measure"], 0, "medium", "analyze", "Easily confused word pair."],
  ],
  "COMM.04": [
    ["Audience analysis mainly determines:", ["Depth, tone and evidence type", "Font choice", "Slide count", "Speaking speed"], 0, "easy", "understand", "Tailor content to prior knowledge and stakes."],
    ["A strong opening should:", ["Earn attention and frame the stakes", "List the agenda only", "Apologise", "Recite the abstract"], 0, "medium", "apply", "Attention is the scarcest resource."],
    ["The best transition from data to recommendation is to:", ["Name the decision the data implies", "Show more data", "Repeat the hypothesis", "End the section"], 0, "hard", "evaluate", "Moves the audience from evidence to action."],
  ],
  "DATA.07": [
    ["Which sample is most biased for estimating school-wide reading habits?", ["Surveys returned by the librarian's club only", "Randomly selected homerooms", "Every fifth student on a roster", "A stratified sample by grade"], 0, "medium", "evaluate", "Self-selection through an affinity group skews results."],
  ],
};

export const SEED_STUDENTS: {
  name: string;
  email: string;
  gradeLevel: string;
  cohort: string;
  goal: string;
  institution: number;
  subjectFocus: string[];
  ability: number;
}[] = [
  { name: "Aisha Rahman", email: "student@adaptiq.ai", gradeLevel: "Grade 11", cohort: "STEM Cohort A", goal: "Reach mastery in inferential statistics before finals", institution: 0, subjectFocus: ["MATH", "DATA", "PHYS"], ability: 0.58 },
  { name: "Diego Fuentes", email: "diego.fuentes@adaptiq.ai", gradeLevel: "Grade 12", cohort: "STEM Cohort A", goal: "Qualify for the national olympiad", institution: 0, subjectFocus: ["MATH", "PHYS"], ability: 0.79 },
  { name: "Mei-Ling Chen", email: "meiling.chen@adaptiq.ai", gradeLevel: "Grade 10", cohort: "STEM Cohort B", goal: "Close algebra gaps before geometry", institution: 0, subjectFocus: ["MATH", "COMM"], ability: 0.44 },
  { name: "Noah Bergman", email: "noah.bergman@adaptiq.ai", gradeLevel: "Grade 11", cohort: "STEM Cohort B", goal: "Prepare for AP Statistics", institution: 0, subjectFocus: ["MATH", "DATA"], ability: 0.52 },
  { name: "Priya Nair", email: "priya.nair@adaptiq.ai", gradeLevel: "Undergraduate Y2", cohort: "CS Foundations", goal: "Land a backend internship", institution: 1, subjectFocus: ["CODE", "DATA"], ability: 0.66 },
  { name: "Tomas Kowalski", email: "tomas.kowalski@adaptiq.ai", gradeLevel: "Undergraduate Y3", cohort: "CS Foundations", goal: "Master dynamic programming", institution: 1, subjectFocus: ["CODE"], ability: 0.71 },
  { name: "Sara Idris", email: "sara.idris@adaptiq.ai", gradeLevel: "Undergraduate Y1", cohort: "Data Analytics", goal: "Build a portfolio of ML projects", institution: 1, subjectFocus: ["DATA", "MATH"], ability: 0.49 },
  { name: "Lucas Ferreira", email: "lucas.ferreira@adaptiq.ai", gradeLevel: "Undergraduate Y2", cohort: "Data Analytics", goal: "Improve model evaluation intuition", institution: 1, subjectFocus: ["DATA", "CODE"], ability: 0.62 },
  { name: "Hana Suzuki", email: "hana.suzuki@adaptiq.ai", gradeLevel: "Bootcamp W3", cohort: "Full-Stack Sprint", goal: "Ship a tested REST API", institution: 2, subjectFocus: ["CODE"], ability: 0.36 },
  { name: "Omar Haddad", email: "omar.haddad@adaptiq.ai", gradeLevel: "Bootcamp W6", cohort: "Full-Stack Sprint", goal: "Pass the technical interview", institution: 2, subjectFocus: ["CODE", "COMM"], ability: 0.55 },
  { name: "Grace Mwangi", email: "grace.mwangi@adaptiq.ai", gradeLevel: "Grade 9", cohort: "STEM Cohort C", goal: "Catch up on fractions and ratios", institution: 0, subjectFocus: ["MATH", "COMM"], ability: 0.31 },
  { name: "Ethan Brooks", email: "ethan.brooks@adaptiq.ai", gradeLevel: "Corporate L2", cohort: "Analytics Upskilling", goal: "Move into a data analytics role", institution: 3, subjectFocus: ["DATA", "MATH"], ability: 0.57 },
  { name: "Zara Ali", email: "zara.ali@adaptiq.ai", gradeLevel: "Corporate L3", cohort: "Analytics Upskilling", goal: "Lead forecasting for the operations team", institution: 3, subjectFocus: ["DATA", "COMM"], ability: 0.68 },
  { name: "Ivan Petrov", email: "ivan.petrov@adaptiq.ai", gradeLevel: "Corporate L2", cohort: "Analytics Upskilling", goal: "Refresh statistics fundamentals", institution: 3, subjectFocus: ["MATH", "DATA"], ability: 0.41 },
];

export const SEED_STAFF = [
  { name: "Elena Novak", email: "teacher@adaptiq.ai", role: "teacher", cohort: "STEM Cohort A", institution: 0, goal: "Differentiate instruction with mastery data" },
  { name: "Marcus Webb", email: "trainer@adaptiq.ai", role: "trainer", cohort: "Analytics Upskilling", institution: 3, goal: "Run cohort-level skill bootcamps" },
  { name: "Dr. Amara Osei", email: "institution@adaptiq.ai", role: "institution", cohort: null, institution: 1, goal: "Lift first-year pass rates above the faculty benchmark" },
  { name: "Sofia Lindqvist", email: "admin@adaptiq.ai", role: "admin", cohort: null, institution: null, goal: "Keep model quality and coverage healthy platform-wide" },
];
