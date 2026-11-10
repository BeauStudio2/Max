"""Run once on your own computer to connect Max to Garmin.

    pip install garminconnect
    python scripts/garmin_login.py

It signs in to Garmin Connect (asks for your email, password and the MFA code if you use one) and prints a long
token string. Paste that string into the GARMIN_TOKENS secret in the Max GitHub repo. Your password is not saved.
The tokens last about a year; run this again if the daily sync starts failing to sign in.
"""
from getpass import getpass

from garminconnect import Garmin

email = input("Garmin email: ").strip()
password = getpass("Garmin password: ")
g = Garmin(email, password, prompt_mfa=lambda: input("MFA code: ").strip())
g.login()
print("\nCopy everything between the lines into the GARMIN_TOKENS secret:\n" + "-" * 60)
print(g.garth.dumps())
print("-" * 60)
