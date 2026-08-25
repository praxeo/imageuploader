# Image Uploader

Phone-to-desktop file transfer over a QR code, running on a Cloudflare Worker.

https://imageuploader.obert-john.workers.dev/

Open the site on a desktop and scan the QR code with a phone. Photos relay
directly from the phone to the connected desktop (JPEGs up to 3 MiB). For
other file types, the phone page has a link that uploads through temporary
R2 storage in 8 MiB multipart chunks — files up to 5 GiB, deleted
automatically after 24 hours.

## Deployment

Merging to the production branch deploys automatically through Cloudflare's
Git integration; `wrangler.toml` declares all bindings. The only manual step
is creating the private R2 bucket `imageuploader-files` once in the
dashboard — see [R2_SETUP.md](R2_SETUP.md).
