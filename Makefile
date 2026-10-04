.PHONY: check test-launcher test-opencode test-opencode-native splash
PYTHON ?= python3.14

check:
	$(PYTHON) scripts/check-runtime.py

test-launcher:
	OPTION14_LAUNCHER="$(CURDIR)/startllamacpp.sh" $(PYTHON) splash/dev/benchmarks/test_bonsai_launcher.py

test-opencode:
	cd opencode && npm test

test-opencode-native:
	cd opencode && npm run test:loop-handoff

splash:
	$(MAKE) -C splash all
