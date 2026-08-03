# Build and send plugin to vaults
# Plugin id MUST match the manifest.json "id" field — Obsidian (esp. mobile)
# validates folder name == id.  Do NOT rename this without updating manifest.
PLUGIN_ID="sticky-headings-no-flicker"

npm run build

# create the distribution directory using the plugin id
mkdir -p "$PLUGIN_ID"

# copy the built files into it (outputs are in root, not dist)
cp main.js "$PLUGIN_ID"
cp manifest.json "$PLUGIN_ID"
cp styles.css "$PLUGIN_ID"

# send to my novel writing vault
cp -r "$PLUGIN_ID" "/Users/caffae/Notes/Novel-Writing/.obsidian/plugins/"
cp -r "$PLUGIN_ID" "/Users/caffae/Notes/ZettelPublish (Content Creator V2 April 2025)/.obsidian/plugins/"
cp -r "$PLUGIN_ID" "/Users/caffae/Notes/Journal/.obsidian/plugins/"

# remove stale fork folder (old mismatched name) so there's no confusion
for vault in "Novel-Writing" "ZettelPublish (Content Creator V2 April 2025)" "Journal"; do
  rm -rf "/Users/caffae/Notes/$vault/.obsidian/plugins/obsidian-sticky-headings-no-flicker"
done

echo "Updated $PLUGIN_ID in novel writing, journal and zettelpublish folders"
