set -e
cd "$DSH_CHECKOUT"
npx tsc -p tsconfig.json
mkdir -p lib
cp -r build/* lib/
