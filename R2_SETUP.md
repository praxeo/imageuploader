# R2 file-transfer setup

The existing QR code supports both photo and generic file transfers:

1. Keep the destination desktop browser open on the Photo Relay page.
2. Scan its QR code with the phone.
3. On the phone page, select **Send documents or other files instead**.
4. Select and send one or more files.
5. A **Download file** button appears in the destination browser when each
   upload completes.

Files use 8 MiB multipart uploads, can be up to 5 GiB, and are automatically
deleted after 24 hours. The original photo route retains its 3 MiB JPEG limit.

## One-time Cloudflare dashboard setup

No local Wrangler installation is required:

1. Sign in to the Cloudflare dashboard.
2. Open **R2 Object Storage** and select **Create bucket**.
3. Create a private bucket named exactly **`imageuploader-files`**.
4. In **Workers & Pages**, select the `imageuploader` Worker and verify under
   **Settings > Builds** that it watches the intended production branch.
5. Merge the change. Cloudflare's Git integration deploys it automatically.

The committed `wrangler.toml` declares the `FILES` binding, so it does not need
to be added manually in the Worker settings. If a build cannot find the bucket,
confirm that the bucket is in the same Cloudflare account as the Worker and
retry the build from the Worker's **Deployments** page.
