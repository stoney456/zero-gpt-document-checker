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
