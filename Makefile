.PHONY: install build test browser verify bench example pack clean
install:
	npm ci
build:
	npm run build
test:
	npm test
browser:
	npm run test:browser
verify:
	npm run verify
bench: build
	npm run bench:tasks
example: build
	npm run example:dev
pack: build
	npm pack
clean:
	npm run clean
