.PHONY: export serve resolve-tco enum-drive deploy

DB ?= ../yume-archive-site/data/important-community.sqlite3
OUT ?= data
DRIVE_MAP ?= ../yume-archive-site/data/drive-map.json
TCO_MAP ?= ../yume-archive-site/data/tco-map.json
DRIVE_FOLDER ?= 1a22wGn2sznJDhh-CGAw1D1foYXqIJiKz
PORT ?= 8787

export:
	python3 scripts/export_static.py --db $(DB) --out $(OUT) --drive-map $(DRIVE_MAP) --tco-map $(TCO_MAP)

serve:
	python3 scripts/dev_server.py --root . --port $(PORT)

resolve-tco:
	python3 scripts/resolve_tco.py --db $(DB) --out $(TCO_MAP)

enum-drive:
	python3 scripts/enumerate_drive.py --folder $(DRIVE_FOLDER) --out $(DRIVE_MAP) --merge

deploy:
	vercel --prod
