"""config.load(): what a server set up by someone else reads from its environment."""

import logging

import pytest

from fone import config

KEYS = ("FONE_ROOMS", "FONE_CHANNEL_ALIASES", "FONE_FILENAME_TZ", "FONE_DEFAULT_DELAY", "FONE_REACTION_SECONDS",
        "FONE_ADS_REFS", "FONE_ADS_CHANNELS", "FONE_IMPORT_DIR", "FONE_REC_DIR", "TZ",
        *(f"FONE_{f.upper()}" for f in config.FEATURES))


@pytest.fixture
def env(monkeypatch, tmp_path):
    for k in KEYS:
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("FONE_REC_DIR", str(tmp_path))

    def set_env(**kv):
        for k, v in kv.items():
            monkeypatch.setenv(k, v)
        return config.load()
    return set_env


def test_no_room_by_default_and_the_log_says_what_that_leaves_out(env, caplog):
    with caplog.at_level(logging.WARNING, logger="fone.config"):
        cfg = env()
    assert cfg.rooms == {} and cfg.channel_aliases == {}
    assert "FONE_ROOMS is empty" in caplog.text and "弹幕" in caplog.text
    assert config.notes(cfg) == [r.getMessage() for r in caplog.records]
    caplog.clear()
    with caplog.at_level(logging.WARNING, logger="fone.config"):
        env(FONE_ROOMS="12345678=MyStreamer")
    assert not caplog.records


def test_a_room_names_its_own_folder_and_an_alias_wins(env):
    cfg = env(FONE_ROOMS="12345678=MyStreamer, 777=Other")
    assert cfg.rooms == {12345678: "MyStreamer", 777: "Other"}
    # fone-recorder's {{ roomId }}/ folders are the channels FONE_ROOMS names
    assert cfg.channel_aliases == {"12345678": "MyStreamer", "777": "Other"}
    cfg = env(FONE_CHANNEL_ALIASES="AccountName=MyStreamer,777=Renamed")
    assert cfg.channel_aliases == {"12345678": "MyStreamer", "777": "Renamed", "AccountName": "MyStreamer"}


def test_empty_values_are_defaults(env):
    # (docker-compose.yml passes a setting through even when .env leaves it empty)
    cfg = env(FONE_FILENAME_TZ="", FONE_DEFAULT_DELAY="", FONE_REACTION_SECONDS="", FONE_ADS="", FONE_ADS_CHANNELS="",
              FONE_ADS_REFS="", FONE_ROOMS="", FONE_CHANNEL_ALIASES="")
    assert cfg.filename_tz.key == config.FILENAME_TZ == "Asia/Shanghai"
    assert (cfg.default_delay, cfg.reaction_seconds) == (40.0, 0.9)
    assert cfg.features == frozenset(config.FEATURES)
    assert cfg.ads_refs is None and cfg.ads_channels is None


def test_the_file_name_zone(env):
    assert env(FONE_FILENAME_TZ="Europe/London").filename_tz.key == "Europe/London"
    assert env(FONE_FILENAME_TZ=" UTC ").filename_tz.key == "UTC"
    with pytest.raises(ValueError, match="FONE_FILENAME_TZ='Beijing' isn't a time zone"):
        env(FONE_FILENAME_TZ="Beijing")


def test_features_and_ads(env, tmp_path):
    cfg = env(FONE_DANMAKU="0", FONE_BACKFILL="off", FONE_ADS_CHANNELS=" A ,B,,", FONE_ADS_REFS=str(tmp_path))
    assert "danmaku" not in cfg.features and "backfill" not in cfg.features and "ads" in cfg.features
    assert cfg.ads_channels == {"A", "B"} and cfg.ads_refs == tmp_path
    assert env(FONE_ADS_CHANNELS="*").ads_channels == {"*"}


def test_notes_for_missing_folders(env, tmp_path):
    cfg = env(FONE_ROOMS="1=a", FONE_REC_DIR=str(tmp_path / "nope"), FONE_IMPORT_DIR=str(tmp_path / "imp"))
    text = " ".join(config.notes(cfg))
    assert "FONE_REC_DIR" in text and "FONE_IMPORT_DIR" in text and "FONE_ROOMS" not in text
