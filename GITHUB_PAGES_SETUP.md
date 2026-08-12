# GitHub Pages Setup Instructions

Your deployment workflow is now in place! Follow these steps to enable GitHub Pages:

## Step 1: Enable GitHub Pages

1. Go to your repository: **https://github.com/zskylarli/onkio**

2. Click on **Settings** (top navigation)

3. In the left sidebar, click **Pages** (under "Code and automation")

4. Under **Build and deployment**:
   - **Source**: Select **"GitHub Actions"** from the dropdown
   - That's it! No need to select a branch when using Actions.

5. Click **Save** if there's a save button

## Step 2: Wait for Deployment

1. Go to the **Actions** tab in your repository

2. You should see a workflow run called "Deploy to GitHub Pages" starting automatically

3. Click on it to watch the progress (takes about 1-2 minutes)

4. Once it shows a green checkmark, your site is live!

## Step 3: Access Your Site

Your site will be available at:

**https://zskylarli.github.io/onkio/**

## Troubleshooting

If the Actions tab shows an error:

1. **Permissions error**: 
   - Go to Settings → Actions → General
   - Scroll to "Workflow permissions"
   - Select "Read and write permissions"
   - Check "Allow GitHub Actions to create and approve pull requests"
   - Save

2. **Pages not building**:
   - Make sure you selected "GitHub Actions" as the source (not a branch)
   - Check that the workflow file exists at `.github/workflows/deploy.yml`

## What Happens Next

Every time you push to the `master` branch:
- GitHub Actions automatically builds your app
- Runs all 351 tests
- Deploys the new version to GitHub Pages
- No manual steps needed!

## Manual Deployment

You can also trigger a deployment manually:
1. Go to Actions tab
2. Click "Deploy to GitHub Pages" in the left sidebar
3. Click "Run workflow" button
4. Select the master branch
5. Click "Run workflow"
