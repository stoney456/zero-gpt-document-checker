# zero-gpt-document-checker

This is my Year 3 Major Project in Temasek Polytechnic to create an application to check documents in Google Docs for level of contribution and progressive timed contribution of students. It also helps to check for AI plagiarism via the GeminiAPI

Link to application:
https://user-contribution-and-ai-plagiarism.onrender.com

To run this locally, you must:
1. Go to Google Cloud Console (https://console.cloud.google.com). Sign in via your own Google Account if you are new to this. Create a project and give it a name.
2. You must also create a client and give it a name.
3. In the search bar, search for the **Google Drive API** and **Google Docs API** and enable both of them.
4. On Google Cloud Console, go to IAM & Services > Service Accounts. Click on the name of the client you just created. 
5. Click **Add Key** > **Create new key**. Select **JSON** and click **Create**
6. The JSON file will be downloaded. Rename it to **service-key.json** and put it in the scripts folder
7. To have the Gemini API key, you must go to Google AI Studio (https://aistudio.google.com) . Sign in with your own Google account if you are new to this.
8. On the Google AI Studio dashboard, on the left panel, click on **Get API key**. Once done, click on **Create API key**
9. In the repository, create a file called **.env**. Inside the **.env** file, create a variable called "**GEMINI_API_KEY**". Copy over the recently created API key and store it in quotation marks for the variable.

Also add an environment variable called QUEUE_CONCURRENCY, and give it any numerical value as it sets the limit for the number of analysis jobs that is allowed at the same time.

To set up Supabase, follow these steps:
1. Go to your Supabase project dashboard (https://app.supabase.com), and create a project. 
2. Go to your Supabase project dashboard (https://app.supabase.com), and create a project.
3. Once your project is created, go to **Project Settings** > **API**. Copy the **Project URL** and the **service_role** key.
4. In your **.env** file, create two variables called **SUPABASE_URL** and **SUPABASE_SECRET_KEY**. Paste the Project URL and service_role key into them respectively, in quotation marks.
5. On the Supabase dashboard, go to **SQL Editor** > **New query**. Paste the following SQL query and click **Run** to create the `history` table, which stores metadata for every completed analysis:

```sql
create table if not exists history (
  id text primary key,
  doc_id text,
  title text,
  generated_at text,
  user_summary text,
  pdf_path text,
  csv_summary_path text,
  csv_revisions_path text,
  ai_analysis_path text,
  user_text_path text,
  json_path text,
  created_at timestamptz not null default now()
);
```

6. In the same **SQL Editor**, open a new query and run the following to create the `job_queue` table, which tracks the status of queued and running analysis jobs so that job state is not lost if the server restarts:

```sql
create table if not exists job_queue (
  id text primary key,
  doc_id text,
  status text not null default 'queued',
  step text,
  progress_current int,
  progress_total int,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

7. Go to **Table Editor** on the sidebar and confirm both **history** and **job_queue** tables now appear, with the columns listed above.
8. Go to **Storage** on the sidebar and click **New bucket**. Name it exactly **report** (this must match the bucket name used in the code). Leave it as a **Private** bucket, since the app generates temporary signed URLs for downloads rather than serving files publicly. Click **Create bucket**.
9. To test that everything is set up correctly, run the app locally, submit a Google Doc URL, and check that a row appears in both the **job_queue** and **history** tables on Supabase, and that a folder containing the generated files appears in the **report** storage bucket.