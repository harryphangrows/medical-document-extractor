# Implementation Notes

## Why I chose this challenge:

This challenge focuses on data processing. It is visual, has clear and short requirements
This is also a real problem that insurance companies often face — cleaning dirty data. 
It helps employees and companies save a lot of time and reduce junk data.
I can reuse the old environment from the previous project 08.

---

## Working process:

Read and understand the requirements carefully.  
Create the correct CSV file with Schema and Issues.  
Read the requirements carefully.  
Read the Evaluation Criteria carefully.

Work with AI to give the correct context and requirements, and check if AI did the flow correctly.  
Add more extra cases outside the requirements to match real situations.  
Check the functions AI wrote and check the flow again. Make sure it runs correctly and fully.  
Check the data AI created with my eyes against the task items, and check with AI tools.  
Check the output data to make sure it is correct.  
Check the report file to make sure AI functions run correctly, fully, and the data is accurate.

---

After understanding, solve the problem by dividing it into phases:

> Create the base, generate data. Meet the requirements and have enough Issues.

> Create the clean script file:  
> Standardize the data, calculate, and think of ideas to add more cases (advanced cases).  
> Create the clean data file as required and process the report at the same time.

Check the data and compare it in reality by reading the data with my eyes and using test tools.  
Read all the functions written by AI to know clearly what the AI coded and how it works. Check if the functions cover all the requirements of the test.

Check the AI processing result. Working process:  
Read the data file `dirty_claims.csv`.

---

## Data cleaning part, notes:

Currently, I use an array (Map) to define `claim_type` for this test. In reality, when data comes in, we should clean it from the beginning by letting users choose options. If not, we should use a Fuzzy Matching algorithm (e.g., Levenshtein distance) to predict and group the results. This is more compact and effective for big data.

Same for `DIAGNOSIS` (for real data, we should call an AI API to accurately predict missing words or spelling mistakes).

Delete duplicate rows with the function: `removeExactDuplicates`.  
Create a for loop to clean each row with the `transformRow` function.  
Process issues for 9 headers of this dirty data and return the clean row.

Add 3 more issues:

- Handle the case of wrong future dates.
- Group diseases into disease codes to avoid confusion.
- Report the average money separately by VND and THB below.

(For invalid money, I chose to delete it instead of flagging it, because we can choose 1 of 2 options).  
Then write to `clean_claims.csv`.

---

## Report part:

- Count the total number of rows before/after cleaning and the deleted duplicate rows (created a `duplicatesRemoved` variable to save to the report).
- Number of detected errors: Create an Object Map `formatIssueTable` to save the report table (here it follows the requirements and adds a bonus for future dates... if we need to catch more errors, we will add them to this array).
- Report `claimsByType` table.
- Report `status` table.
- With the average money of each type, processed by the `calcAvgByTypeAndCurrency` function to separate the average money by currency.
- Use `sums` to store the value and `count` to calculate the average for the 2 current currencies. Output a separate table for each type (to avoid the mistake of adding VND and THB together and dividing, which is wrong).
- Finally, the `topDiagnoses` function to calculate the top 5 most common diagnoses.
