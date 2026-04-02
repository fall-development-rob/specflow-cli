.PHONY: build build-native test install clean doctor

build:
	npx tsc

build-native:
	cd rust && cargo build --release

test:
	npx tsc
	npm test

install:
	npm install -g .

clean:
	rm -rf dist rust/target

doctor:
	node dist/cli.js doctor
